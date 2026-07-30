from __future__ import annotations

import importlib
import json
import hashlib
import math
import os
import shutil
import sqlite3
import subprocess
import sys
import threading
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Iterator

import cv2
import numpy as np

try:
    import torch
except ImportError:
    torch = None

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field


PLATFORM_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = PLATFORM_DIR.parent
VIDEO_DIR = Path(
    os.getenv("YUGUANG_VIDEO_DIR", str(PROJECT_DIR / "video"))
).resolve()
DATA_DIR = Path(
    os.getenv("YUGUANG_DATA_DIR", str(PLATFORM_DIR / "data"))
).resolve()
RESULT_DIR = DATA_DIR / "analyses"
POSE_DIR = DATA_DIR / "poses"
DB_PATH = DATA_DIR / "yuguang.db"
MODEL_VERSION = "opencv-motion-baseline-1.2"
RULE_VERSION = "movement-rules-1.1"
SCHEMA_VERSION = "2"
POSE_CACHE_VERSION = "2"
MIN_ANALYSIS_SEGMENT_SECONDS = 5.0
MAX_ANALYSIS_SEGMENT_SECONDS = 30.0 * 60.0

DATA_DIR.mkdir(parents=True, exist_ok=True)
RESULT_DIR.mkdir(parents=True, exist_ok=True)
POSE_DIR.mkdir(parents=True, exist_ok=True)

DB_LOCK = threading.Lock()


def is_ascii_path(path: Path) -> bool:
    try:
        str(path).encode("ascii")
        return True
    except UnicodeEncodeError:
        return False


def runtime_cache_root() -> Path:
    configured = os.getenv("YUGUANG_RUNTIME_CACHE_DIR")
    system_drive = os.getenv("SystemDrive", "C:").rstrip("\\/")
    candidates = [
        Path(configured) if configured else None,
        Path(tempfile.gettempdir()) / "yuguang-digital-coach",
        Path(os.getenv("PUBLIC", f"{system_drive}\\Users\\Public"))
        / "YuguangRuntimeCache",
        Path(f"{system_drive}\\") / "YuguangRuntimeCache",
    ]
    for candidate in candidates:
        if candidate is None:
            continue
        try:
            candidate = candidate.expanduser().resolve()
            if not is_ascii_path(candidate):
                continue
            candidate.mkdir(parents=True, exist_ok=True)
            return candidate
        except OSError:
            continue
    raise RuntimeError(
        "无法创建纯英文姿态资源缓存；请设置 YUGUANG_RUNTIME_CACHE_DIR 指向可写的英文路径"
    )


def prepare_mediapipe_import_path() -> None:
    spec = importlib.util.find_spec("mediapipe")
    if spec is None or spec.origin is None:
        return

    package_root = Path(spec.origin).resolve().parent
    if is_ascii_path(package_root):
        return

    cache_root = runtime_cache_root()
    package_key = hashlib.sha256(
        str(package_root).encode("utf-8")
    ).hexdigest()[:12]
    shadow_site_packages = (
        cache_root / "mediapipe-shadow" / package_key / "site-packages"
    )
    shadow_package = shadow_site_packages / "mediapipe"
    shadow_site_packages.mkdir(parents=True, exist_ok=True)

    if not shadow_package.exists():
        linked = False
        if os.name == "nt":
            command_processor = os.getenv(
                "COMSPEC", r"C:\Windows\System32\cmd.exe"
            )
            completed = subprocess.run(
                [
                    command_processor,
                    "/d",
                    "/c",
                    "mklink",
                    "/J",
                    str(shadow_package),
                    str(package_root),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            linked = completed.returncode == 0 and shadow_package.exists()
        else:
            try:
                shadow_package.symlink_to(package_root, target_is_directory=True)
                linked = True
            except OSError:
                linked = False

        if not linked:
            shutil.copytree(package_root, shadow_package, dirs_exist_ok=True)

    shadow_path = str(shadow_site_packages)
    if shadow_path not in sys.path:
        sys.path.insert(0, shadow_path)
    importlib.invalidate_caches()


def initialise_pose_runtime() -> tuple[Any | None, bool, str | None, str | None]:
    try:
        prepare_mediapipe_import_path()
        import mediapipe as mediapipe_module

        package_root = Path(mediapipe_module.__file__).absolute().parent
        resource_root = package_root.parent
        from mediapipe.python._framework_bindings import resource_util

        resource_util.set_resource_dir(str(resource_root))
        with mediapipe_module.solutions.pose.Pose(
            static_image_mode=True,
            model_complexity=1,
            enable_segmentation=False,
        ):
            pass
        return mediapipe_module, True, None, str(resource_root)
    except Exception as exc:
        return None, False, f"{type(exc).__name__}: {exc}", None


mp, POSE_AVAILABLE, POSE_ERROR, POSE_RESOURCE_DIR = initialise_pose_runtime()


def db() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    return connection


def ensure_column(
    connection: sqlite3.Connection, table: str, column: str, definition: str
) -> None:
    columns = {
        row["name"] for row in connection.execute(f"PRAGMA table_info({table})")
    }
    if column not in columns:
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def init_db() -> None:
    with db() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS calibrations (
                video_id TEXT PRIMARY KEY,
                points_json TEXT NOT NULL,
                player_side TEXT NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                video_id TEXT NOT NULL,
                player_side TEXT NOT NULL,
                status TEXT NOT NULL,
                progress INTEGER NOT NULL DEFAULT 0,
                message TEXT NOT NULL,
                analysis_id TEXT,
                error TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS analyses (
                id TEXT PRIMARY KEY,
                video_id TEXT NOT NULL,
                result_json TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS video_names (
                video_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                updated_at REAL NOT NULL
            );
            """
        )
        migrations = {
            "calibrations": {
                "calibration_id": "TEXT",
                "version": "INTEGER NOT NULL DEFAULT 1",
                "created_at": "REAL",
            },
            "jobs": {
                "source": "TEXT NOT NULL DEFAULT 'computed'",
                "start": "REAL NOT NULL DEFAULT 0",
                "duration": "REAL",
            },
            "analyses": {
                "model_version": "TEXT",
                "rule_version": "TEXT",
                "source": "TEXT NOT NULL DEFAULT 'computed'",
                "schema_version": "TEXT",
                "file_fingerprint": "TEXT",
                "player_side": "TEXT",
                "calibration_id": "TEXT",
                "segment_start": "REAL NOT NULL DEFAULT 0",
                "segment_duration": "REAL",
                "cache_valid": "INTEGER NOT NULL DEFAULT 1",
            },
        }
        for table, columns in migrations.items():
            for column, definition in columns.items():
                ensure_column(connection, table, column, definition)
        connection.executescript(
            """
            CREATE INDEX IF NOT EXISTS analyses_video_created_idx
            ON analyses(video_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS analyses_cache_lookup_idx
            ON analyses(
                video_id, file_fingerprint, player_side, calibration_id,
                segment_start, segment_duration, model_version, rule_version,
                schema_version, cache_valid
            );
            UPDATE jobs
            SET status='failed',
                progress=100,
                message='服务重启，原分析任务已中止',
                error='analysis_worker_restarted',
                updated_at=strftime('%s','now')
            WHERE status IN ('queued', 'running');
            """
        )


init_db()

app = FastAPI(title="羽光智教本地分析服务", version="1.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_origin_regex=r"^http://(?:localhost|127\.0\.0\.1):\d+$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CalibrationPayload(BaseModel):
    points: list[list[float]] = Field(min_length=4, max_length=4)
    player_side: str = "near"


class AnalysisPayload(BaseModel):
    video_id: str
    player_side: str = "near"
    calibration_id: str | None = None
    start: float = Field(default=0, ge=0)
    duration: float | None = Field(
        default=None,
        ge=MIN_ANALYSIS_SEGMENT_SECONDS,
        le=MAX_ANALYSIS_SEGMENT_SECONDS,
    )
    force_recompute: bool = False


class VideoRenamePayload(BaseModel):
    display_name: str = Field(min_length=1, max_length=80)


def video_path(video_id: str) -> Path:
    matches = [path for path in VIDEO_DIR.glob("*.mp4") if path.stem == video_id]
    if not matches:
        raise HTTPException(status_code=404, detail="视频不存在")
    return matches[0]


def available_video_path(filename: str) -> Path:
    raw_name = Path(filename).name.strip()
    if Path(raw_name).suffix.lower() != ".mp4":
        raise HTTPException(status_code=400, detail="当前仅支持 MP4 视频")
    forbidden = '<>:"/\\|?*'
    stem = "".join(
        character
        for character in Path(raw_name).stem
        if character not in forbidden and ord(character) >= 32
    ).strip(" .")
    if not stem:
        stem = f"训练视频-{uuid.uuid4().hex[:8]}"
    stem = stem[:100].rstrip(" .")
    destination = VIDEO_DIR / f"{stem}.mp4"
    suffix = 2
    while destination.exists():
        destination = VIDEO_DIR / f"{stem} ({suffix}).mp4"
        suffix += 1
    return destination


def file_fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    size = path.stat().st_size
    digest.update(str(size).encode("ascii"))
    with path.open("rb") as source:
        digest.update(source.read(1024 * 1024))
        if size > 1024 * 1024:
            source.seek(max(0, size - 1024 * 1024))
            digest.update(source.read(1024 * 1024))
    return digest.hexdigest()


def video_display_name(video_id: str, fallback: str) -> str:
    with db() as connection:
        row = connection.execute(
            "SELECT display_name FROM video_names WHERE video_id = ?",
            (video_id,),
        ).fetchone()
    return row["display_name"] if row else fallback


def probe_video(path: Path) -> dict[str, Any]:
    capture = cv2.VideoCapture(str(path))
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    capture.release()
    duration = frame_count / fps if fps > 0 and frame_count > 0 else 0
    return {
        "id": path.stem,
        "name": path.name,
        "display_name": video_display_name(
            path.stem,
            f"单打训练案例 {path.stem[:4].upper()}",
        ),
        "duration": round(duration, 2),
        "fps": round(fps, 2),
        "width": width,
        "height": height,
        "size": path.stat().st_size,
        "file_fingerprint": file_fingerprint(path),
    }


def latest_analysis(video_id: str) -> str | None:
    with db() as connection:
        row = connection.execute(
            "SELECT id FROM analyses WHERE video_id = ? ORDER BY created_at DESC LIMIT 1",
            (video_id,),
        ).fetchone()
    return row["id"] if row else None


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service_version": app.version,
        "gpu_available": bool(torch is not None and torch.cuda.is_available()),
        "gpu_name": torch.cuda.get_device_name(0) if torch is not None and torch.cuda.is_available() else None,
        "engine": "MediaPipe BlazePose video tracking + OpenCV court mapping",
        "pose_model_available": POSE_AVAILABLE,
        "pose_available": POSE_AVAILABLE,
        "pose_error": POSE_ERROR,
        "resource_dir": POSE_RESOURCE_DIR,
        "model_version": MODEL_VERSION,
        "rule_version": RULE_VERSION,
        "schema_version": SCHEMA_VERSION,
        "shuttle_tracking_enabled": False,
    }


@app.get("/api/videos")
def list_videos() -> list[dict[str, Any]]:
    videos = []
    for path in sorted(VIDEO_DIR.glob("*.mp4")):
        item = probe_video(path)
        item["latest_analysis_id"] = latest_analysis(path.stem)
        videos.append(item)
    return videos


@app.post("/api/videos/import", status_code=201)
async def import_video(request: Request, filename: str) -> dict[str, Any]:
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    destination = available_video_path(filename)
    temporary = DATA_DIR / f"upload-{uuid.uuid4().hex}.mp4"
    written = 0
    try:
        with temporary.open("xb") as target:
            async for chunk in request.stream():
                if not chunk:
                    continue
                target.write(chunk)
                written += len(chunk)
        if written == 0:
            raise HTTPException(status_code=400, detail="所选视频为空")

        capture = cv2.VideoCapture(str(temporary))
        readable = capture.isOpened()
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        capture.release()
        if not readable or frame_count <= 0:
            raise HTTPException(status_code=400, detail="无法读取所选 MP4 视频")

        temporary.replace(destination)
        item = probe_video(destination)
        item["latest_analysis_id"] = None
        return item
    finally:
        temporary.unlink(missing_ok=True)


@app.patch("/api/videos/{video_id}")
def rename_video(video_id: str, payload: VideoRenamePayload) -> dict[str, Any]:
    path = video_path(video_id)
    display_name = payload.display_name.strip()
    if not display_name:
        raise HTTPException(status_code=400, detail="视频名称不能为空")
    if any(ord(character) < 32 for character in display_name):
        raise HTTPException(status_code=400, detail="视频名称包含不可用字符")

    with DB_LOCK:
        with db() as connection:
            connection.execute(
                """
                INSERT INTO video_names(video_id, display_name, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(video_id) DO UPDATE SET
                    display_name=excluded.display_name,
                    updated_at=excluded.updated_at
                """,
                (video_id, display_name, time.time()),
            )

    item = probe_video(path)
    item["latest_analysis_id"] = latest_analysis(video_id)
    return item


def pose_segment(
    video_id: str,
    start: float,
    duration: float,
    sample_fps: float,
    player_side: str,
    force_recompute: bool,
) -> dict[str, Any]:
    if not POSE_AVAILABLE or mp is None:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "pose_service_unavailable",
                "message": "MediaPipe 姿态服务不可用",
                "pose_error": POSE_ERROR,
            },
        )
    if player_side not in {"near", "far"}:
        raise HTTPException(status_code=400, detail="球员侧必须是 near 或 far")
    start = max(0.0, float(start))
    duration = min(30.0, max(2.0, float(duration)))
    sample_fps = min(8.0, max(2.0, float(sample_fps)))
    path = video_path(video_id)
    fingerprint = file_fingerprint(path)
    calibration = calibration_for(video_id)
    cache_parameters = {
        "file_fingerprint": fingerprint,
        "video_id": video_id,
        "segment": [round(start, 3), round(duration, 3)],
        "sample_fps": round(sample_fps, 3),
        "player_side": player_side,
        "calibration_version": calibration["version"],
        "model_version": getattr(mp, "__version__", "unknown"),
        "rule_version": RULE_VERSION,
        "schema_version": SCHEMA_VERSION,
        "pose_cache_version": POSE_CACHE_VERSION,
    }
    cache_key = hashlib.sha256(
        json.dumps(cache_parameters, ensure_ascii=True, sort_keys=True).encode("utf-8")
    ).hexdigest()
    cache_path = POSE_DIR / f"{cache_key}.json"
    if cache_path.exists() and not force_recompute:
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        if (
            cached.get("video_id") == video_id
            and cached.get("file_fingerprint") == fingerprint
            and cached.get("schema_version") == SCHEMA_VERSION
        ):
            return {**cached, "source": "cache"}

    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        capture.release()
        raise HTTPException(status_code=422, detail="视频无法打开或解码")
    source_fps = float(capture.get(cv2.CAP_PROP_FPS) or 30.0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    capture.set(cv2.CAP_PROP_POS_MSEC, start * 1000.0)
    stride = max(1, int(round(source_fps / sample_fps)))
    video_duration = float(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0) / source_fps
    end = min(start + duration, video_duration) if video_duration > 0 else start + duration
    frames: list[dict[str, Any]] = []
    decoded = 0
    sampled = 0
    accepted = 0

    try:
        with mp.solutions.pose.Pose(
            static_image_mode=False,
            model_complexity=1,
            smooth_landmarks=True,
            enable_segmentation=False,
            min_detection_confidence=0.65,
            min_tracking_confidence=0.65,
        ) as pose:
            while capture.isOpened():
                ok, frame = capture.read()
                if not ok:
                    break
                timestamp = float(capture.get(cv2.CAP_PROP_POS_MSEC) / 1000.0)
                if timestamp > end:
                    break
                if decoded % stride:
                    decoded += 1
                    continue
                decoded += 1
                sampled += 1
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                result = pose.process(rgb)
                if not result.pose_landmarks:
                    continue
                points = []
                visible_points = []
                for index, landmark in enumerate(result.pose_landmarks.landmark):
                    item = {
                        "id": index,
                        "x": round(float(landmark.x), 5),
                        "y": round(float(landmark.y), 5),
                        "z": round(float(landmark.z), 5),
                        "visibility": round(float(landmark.visibility), 4),
                    }
                    points.append(item)
                    if landmark.visibility >= 0.5:
                        visible_points.append(item)
                body_ids = list(range(11, 33))
                confidence = float(np.mean([points[index]["visibility"] for index in body_ids]))
                if confidence < 0.58 or len(visible_points) < 12:
                    continue
                xs = [point["x"] for point in visible_points]
                ys = [point["y"] for point in visible_points]
                padding_x = 0.035
                padding_y = 0.055
                bbox = {
                    "x": round(max(0.0, min(xs) - padding_x), 5),
                    "y": round(max(0.0, min(ys) - padding_y), 5),
                    "w": round(min(1.0, max(xs) + padding_x) - max(0.0, min(xs) - padding_x), 5),
                    "h": round(min(1.0, max(ys) + padding_y) - max(0.0, min(ys) - padding_y), 5),
                }
                frames.append({
                    "t": round(timestamp, 3),
                    "confidence": round(confidence, 4),
                    "bbox": bbox,
                    "landmarks": points,
                })
                accepted += 1
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "pose_runtime_failed",
                "message": "姿态推理运行失败",
                "pose_error": f"{type(exc).__name__}: {exc}",
            },
        ) from exc
    finally:
        capture.release()

    average_confidence = (
        float(np.mean([frame["confidence"] for frame in frames])) if frames else 0.0
    )
    failure_reason = None
    if sampled == 0:
        failure_reason = "片段没有可解码的采样帧"
    elif accepted == 0:
        failure_reason = "人物过远、遮挡或画面质量导致所有采样帧低于姿态门槛"
    payload = {
        "video_id": video_id,
        "analysis_id": None,
        "model": "MediaPipe BlazePose GHUM",
        "model_version": getattr(mp, "__version__", "unknown"),
        "schema_version": SCHEMA_VERSION,
        "rule_version": RULE_VERSION,
        "file_fingerprint": fingerprint,
        "calibration_version": calibration["version"],
        "player_side": player_side,
        "mode": "video_tracking",
        "source": "computed",
        "source_width": width,
        "source_height": height,
        "start": start,
        "end": end,
        "sample_fps": sample_fps,
        "confidence_threshold": 0.58,
        "frames": frames,
        "sampled_frames": sampled,
        "accepted_frames": accepted,
        "average_confidence": round(average_confidence, 4),
        "failure_reason": failure_reason,
        "created_at": time.time(),
        "shuttle_tracking": {
            "enabled": False,
            "reason": "未通过真实模型校验，禁止显示羽球检测框或轨迹",
        },
    }
    cache_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return payload


@app.get("/api/videos/{video_id}/pose")
def get_pose_segment(
    video_id: str,
    start: float = 8.0,
    duration: float = 20.0,
    sample_fps: float = 6.0,
    player_side: str = "near",
    force_recompute: bool = False,
) -> JSONResponse:
    return JSONResponse(
        pose_segment(
            video_id,
            start,
            duration,
            sample_fps,
            player_side,
            force_recompute,
        )
    )

def ranged_file(path: Path, start: int, end: int) -> Iterator[bytes]:
    with path.open("rb") as file:
        file.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = file.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


@app.get("/api/videos/{video_id}/stream")
def stream_video(video_id: str, request: Request):
    path = video_path(video_id)
    file_size = path.stat().st_size
    range_header = request.headers.get("range")
    if not range_header:
        return StreamingResponse(
            ranged_file(path, 0, file_size - 1),
            media_type="video/mp4",
            headers={"Accept-Ranges": "bytes", "Content-Length": str(file_size)},
        )

    try:
        byte_range = range_header.replace("bytes=", "").split("-")
        start = int(byte_range[0]) if byte_range[0] else 0
        end = int(byte_range[1]) if len(byte_range) > 1 and byte_range[1] else min(start + 8 * 1024 * 1024, file_size - 1)
        end = min(end, file_size - 1)
        if start < 0 or start >= file_size or end < start:
            raise ValueError
    except ValueError as exc:
        raise HTTPException(status_code=416, detail="无效的视频范围请求") from exc

    return StreamingResponse(
        ranged_file(path, start, end),
        status_code=206,
        media_type="video/mp4",
        headers={
            "Accept-Ranges": "bytes",
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Content-Length": str(end - start + 1),
        },
    )


def cross(a: list[float], b: list[float], c: list[float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def segments_intersect(
    a: list[float], b: list[float], c: list[float], d: list[float]
) -> bool:
    return cross(a, b, c) * cross(a, b, d) < 0 and cross(c, d, a) * cross(c, d, b) < 0


def validate_calibration(points: list[list[float]], player_side: str) -> None:
    if player_side not in {"near", "far"}:
        raise HTTPException(status_code=400, detail="球员侧必须是 near 或 far")
    for point in points:
        if len(point) != 2 or not all(math.isfinite(value) and 0 <= value <= 1 for value in point):
            raise HTTPException(status_code=400, detail="标定点必须是0到1之间的归一化坐标")
    near_left, near_right, far_right, far_left = points
    if near_left[0] >= near_right[0] or far_left[0] >= far_right[0]:
        raise HTTPException(status_code=400, detail="标定点左右顺序错误")
    if (near_left[1] + near_right[1]) / 2 <= (far_left[1] + far_right[1]) / 2:
        raise HTTPException(status_code=400, detail="标定点远近顺序错误")
    if segments_intersect(near_left, near_right, far_right, far_left) or segments_intersect(
        near_right, far_right, far_left, near_left
    ):
        raise HTTPException(status_code=400, detail="标定四边形存在自交")
    area = abs(
        sum(
            points[index][0] * points[(index + 1) % 4][1]
            - points[(index + 1) % 4][0] * points[index][1]
            for index in range(4)
        )
        / 2
    )
    if area < 0.025:
        raise HTTPException(status_code=400, detail="标定区域过小，请重新选择球场四角")


@app.get("/api/videos/{video_id}/calibration")
def get_calibration(video_id: str) -> dict[str, Any]:
    video_path(video_id)
    return calibration_for(video_id)


@app.post("/api/videos/{video_id}/calibration")
def save_calibration(video_id: str, payload: CalibrationPayload) -> dict[str, Any]:
    video_path(video_id)
    validate_calibration(payload.points, payload.player_side)
    now = time.time()
    with DB_LOCK, db() as connection:
        existing = connection.execute(
            "SELECT * FROM calibrations WHERE video_id = ?", (video_id,)
        ).fetchone()
        if (
            existing
            and json.loads(existing["points_json"]) == payload.points
            and existing["player_side"] == payload.player_side
            and existing["calibration_id"]
        ):
            return {
                "video_id": video_id,
                "calibration_id": existing["calibration_id"],
                "version": existing["version"],
                "points": payload.points,
                "player_side": payload.player_side,
                "source": "existing",
            }
        calibration_id = uuid.uuid4().hex
        version = int(existing["version"] or 0) + 1 if existing else 1
        connection.execute(
            """
            INSERT INTO calibrations(
                video_id, points_json, player_side, updated_at,
                calibration_id, version, created_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(video_id) DO UPDATE SET
              points_json=excluded.points_json,
              player_side=excluded.player_side,
              updated_at=excluded.updated_at,
              calibration_id=excluded.calibration_id,
              version=excluded.version,
              created_at=excluded.created_at
            """,
            (
                video_id,
                json.dumps(payload.points),
                payload.player_side,
                now,
                calibration_id,
                version,
                now,
            ),
        )
    return {
        "video_id": video_id,
        "calibration_id": calibration_id,
        "version": version,
        "points": payload.points,
        "player_side": payload.player_side,
        "source": "computed",
    }


def update_job(job_id: str, **values: Any) -> None:
    values["updated_at"] = time.time()
    columns = ", ".join(f"{key} = ?" for key in values)
    params = list(values.values()) + [job_id]
    with DB_LOCK, db() as connection:
        connection.execute(f"UPDATE jobs SET {columns} WHERE id = ?", params)


def calibration_for(video_id: str) -> dict[str, Any]:
    with db() as connection:
        row = connection.execute(
            "SELECT * FROM calibrations WHERE video_id = ?", (video_id,)
        ).fetchone()
    if row:
        calibration_id = row["calibration_id"] or f"legacy-{video_id}"
        return {
            "video_id": video_id,
            "calibration_id": calibration_id,
            "version": int(row["version"] or 1),
            "points": json.loads(row["points_json"]),
            "player_side": row["player_side"],
            "source": "existing",
        }
    return {
        "video_id": video_id,
        "calibration_id": None,
        "version": 0,
        "points": [[0.18, 0.88], [0.82, 0.88], [0.62, 0.22], [0.38, 0.22]],
        "player_side": "near",
        "source": "template",
    }


def transform_point(matrix: np.ndarray, x: float, y: float) -> tuple[float, float]:
    vector = np.array([x, y, 1.0], dtype=np.float32)
    projected = matrix @ vector
    if abs(float(projected[2])) < 1e-6:
        return 3.05, 6.7
    return float(projected[0] / projected[2]), float(projected[1] / projected[2])


def candidate_matches_player_side(
    matrix: np.ndarray,
    pixel: tuple[float, float],
    player_side: str,
) -> bool:
    """Classify a motion candidate in calibrated court space, not image space."""
    court_x, court_y = transform_point(matrix, pixel[0], pixel[1])
    if not (-0.8 <= court_x <= 6.9 and -1.5 <= court_y <= 14.9):
        return False
    return court_y >= 6.7 if player_side == "near" else court_y < 6.7


def compress_tracks(tracks: list[dict[str, float]], limit: int = 420) -> list[dict[str, float]]:
    if len(tracks) <= limit:
        return tracks
    stride = max(1, math.ceil(len(tracks) / limit))
    return tracks[::stride]


def build_advice(metrics: dict[str, float], tracks: list[dict[str, float]]) -> list[dict[str, Any]]:
    if not tracks:
        evidence = 0.0
    else:
        evidence = max(tracks, key=lambda item: abs(item["x"] - 3.05) + abs(item["y"] - 6.7))["t"]

    dominant_side = "左侧" if metrics["left_ratio"] > metrics["right_ratio"] else "右侧"
    weaker_side = "右侧" if dominant_side == "左侧" else "左侧"
    balance_delta = abs(metrics["left_ratio"] - metrics["right_ratio"])
    advice: list[dict[str, Any]] = []
    if metrics["return_efficiency"] < 55:
        advice.append({
            "title": "击球后更快回到可衔接位置",
            "observation": f"平均回中效率为 {metrics['return_efficiency']:.0f} 分，离开中心后的恢复仍有压缩空间。",
            "action": "完成击球后先做小幅并步回收，再以分腿垫步进入下一拍准备；进行6组30秒“击球—回中—启动”循环。",
            "evidence_time": round(evidence, 1),
            "confidence": round(min(0.92, 0.65 + (55 - metrics["return_efficiency"]) / 100), 2),
            "metric": "return_efficiency",
            "operator": "<",
            "threshold": 55,
            "evidence": {"timestamp": round(evidence, 1), "value": metrics["return_efficiency"]},
            "recommendation": "击球—回中—启动循环",
            "rule_version": RULE_VERSION,
            "source": "rule",
            "knowledge_source": "BWF Coach Education Level 1 · Movement principles",
        })
    if balance_delta > 20:
        advice.append({
            "title": f"降低{dominant_side}移动依赖，补足{weaker_side}覆盖",
            "observation": f"左右场活动占比为 {metrics['left_ratio']:.0f}% / {metrics['right_ratio']:.0f}%，差值 {balance_delta:.0f} 个百分点。",
            "action": "用六码点多球练习补足低覆盖侧，要求每次触点后回到中线附近，再由同伴随机给出下一点。",
            "evidence_time": round(tracks[len(tracks) // 2]["t"], 1) if tracks else 0,
            "confidence": round(min(0.9, 0.62 + balance_delta / 150), 2),
            "metric": "balance_delta",
            "operator": ">",
            "threshold": 20,
            "evidence": {
                "timestamp": round(tracks[len(tracks) // 2]["t"], 1) if tracks else 0,
                "left_ratio": metrics["left_ratio"],
                "right_ratio": metrics["right_ratio"],
            },
            "recommendation": "低覆盖侧六码点多球",
            "rule_version": RULE_VERSION,
            "source": "rule",
            "knowledge_source": "BWF Coach Education Level 1 · Court movement",
        })
    if metrics["coverage"] < 40:
        advice.append({
            "title": "扩大有效覆盖而非增加无效跑动",
            "observation": f"本段覆盖 {metrics['coverage']:.0f}% 的球场网格，估算移动距离 {metrics['distance']:.1f} 米。",
            "action": "训练时把注意力放在启动时机与到位后的身体稳定，使用前后场四点组合练习，每组8拍并记录是否能在击球前完成制动。",
            "evidence_time": round(tracks[-1]["t"] * 0.7, 1) if tracks else 0,
            "confidence": round(min(0.88, 0.62 + (40 - metrics["coverage"]) / 100), 2),
            "metric": "coverage",
            "operator": "<",
            "threshold": 40,
            "evidence": {
                "timestamp": round(tracks[-1]["t"] * 0.7, 1) if tracks else 0,
                "value": metrics["coverage"],
                "distance": metrics["distance"],
            },
            "recommendation": "前后场四点组合",
            "rule_version": RULE_VERSION,
            "source": "rule",
            "knowledge_source": "BWF Coach Education Level 1 · Technical and tactical elements",
        })
    if not advice:
        advice.append({
            "title": "保持当前移动平衡并提高稳定复现率",
            "observation": "本段回中、左右平衡和覆盖率均未触发纠偏阈值。",
            "action": "维持当前训练强度，用相同片段条件复测三次，确认指标能够稳定复现。",
            "evidence_time": round(evidence, 1),
            "confidence": 0.7,
            "metric": "all_movement_rules",
            "operator": "pass",
            "threshold": None,
            "evidence": {"timestamp": round(evidence, 1)},
            "recommendation": "同条件重复测试",
            "rule_version": RULE_VERSION,
            "source": "rule",
            "knowledge_source": "Yuguang movement baseline",
        })
    return advice


def analyse_video(
    job_id: str,
    video_id: str,
    player_side: str,
    segment_start: float,
    segment_duration: float | None,
    fingerprint: str,
    calibration_id: str | None,
) -> None:
    try:
        path = video_path(video_id)
        meta = probe_video(path)
        update_job(job_id, status="running", progress=4, message="正在读取视频与球场标定")
        capture = cv2.VideoCapture(str(path))
        if not capture.isOpened():
            raise RuntimeError("视频无法打开，请确认OneDrive文件已下载到本机")

        fps = meta["fps"] or 25.0
        total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        sample_step = max(1, int(fps * 0.5))
        width = meta["width"] or int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = meta["height"] or int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        calibration = calibration_for(video_id)
        if calibration_id and calibration["calibration_id"] != calibration_id:
            raise RuntimeError("标定版本已变化，请重新提交分析")
        points = calibration["points"]
        source = np.array([[x * width, y * height] for x, y in points], dtype=np.float32)
        target = np.array([[0, 13.4], [6.1, 13.4], [6.1, 0], [0, 0]], dtype=np.float32)
        homography = cv2.getPerspectiveTransform(source, target)

        previous_gray: np.ndarray | None = None
        previous_pixel: tuple[float, float] | None = None
        tracks: list[dict[str, float]] = []
        segment_start = min(max(0.0, segment_start), max(meta["duration"], 0))
        effective_duration = (
            min(segment_duration, max(0.0, meta["duration"] - segment_start))
            if segment_duration is not None and meta["duration"] > 0
            else max(0.0, meta["duration"] - segment_start)
        )
        if effective_duration <= 0:
            raise RuntimeError("分析片段为空，请重新设置起止时间")
        segment_end = segment_start + effective_duration
        capture.set(cv2.CAP_PROP_POS_MSEC, segment_start * 1000)
        frame_index = int(round(segment_start * fps))
        sampled = 0
        expected_samples = max(1, int(math.ceil(effective_duration * fps / sample_step)))

        while True:
            ok, frame = capture.read()
            if not ok:
                break
            timestamp = float(capture.get(cv2.CAP_PROP_POS_MSEC) / 1000.0)
            if timestamp > segment_end:
                break
            if frame_index % sample_step != 0:
                frame_index += 1
                continue

            scale = min(1.0, 720 / max(width, 1))
            frame_small = cv2.resize(frame, None, fx=scale, fy=scale)
            gray = cv2.cvtColor(frame_small, cv2.COLOR_BGR2GRAY)
            gray = cv2.GaussianBlur(gray, (7, 7), 0)
            point: tuple[float, float] | None = None
            confidence = 0.35

            if previous_gray is not None:
                diff = cv2.absdiff(previous_gray, gray)
                _, mask = cv2.threshold(diff, 24, 255, cv2.THRESH_BINARY)
                mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
                contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                candidates: list[tuple[float, tuple[float, float]]] = []
                for contour in contours:
                    area = cv2.contourArea(contour)
                    if area < 180 or area > gray.shape[0] * gray.shape[1] * 0.18:
                        continue
                    x, y, w, h = cv2.boundingRect(contour)
                    foot_y = y + h
                    pixel = ((x + w / 2) / scale, foot_y / scale)
                    if not candidate_matches_player_side(
                        homography,
                        pixel,
                        player_side,
                    ):
                        continue
                    shape_bonus = 1.25 if h >= w else 0.8
                    candidates.append((area * shape_bonus, pixel))
                if candidates:
                    score, point = max(candidates, key=lambda item: item[0])
                    confidence = min(0.92, 0.45 + score / max(gray.size * 0.08, 1))

            if point is None:
                point = previous_pixel
                confidence = 0.28
            if point is not None:
                court_x, court_y = transform_point(homography, point[0], point[1])
                if -0.8 <= court_x <= 6.9 and -1.5 <= court_y <= 14.9:
                    tracks.append(
                        {
                            "t": round(timestamp, 2),
                            "x": round(min(6.1, max(0, court_x)), 3),
                            "y": round(min(13.4, max(0, court_y)), 3),
                            "confidence": round(confidence, 2),
                        }
                    )
                    previous_pixel = point

            previous_gray = gray
            sampled += 1
            if sampled % 15 == 0:
                progress = min(78, 8 + int(sampled / expected_samples * 70))
                update_job(job_id, progress=progress, message=f"正在提取球员轨迹 · {progress}%")
            frame_index += 1

        capture.release()
        if len(tracks) < 8:
            raise RuntimeError("有效运动轨迹不足，请重新标定球场或切换近/远场球员")

        update_job(job_id, progress=84, message="正在计算移动指标与证据片段")
        distance = 0.0
        valid_steps = 0
        for first, second in zip(tracks, tracks[1:]):
            step = math.dist((first["x"], first["y"]), (second["x"], second["y"]))
            if step <= 3.2:
                distance += step
                valid_steps += 1

        left_count = sum(item["x"] < 3.05 for item in tracks)
        left_ratio = left_count / len(tracks) * 100
        center_distances = [math.dist((item["x"], item["y"]), (3.05, 6.7)) for item in tracks]
        return_efficiency = max(12.0, min(96.0, 100 - np.mean(center_distances) / 7.2 * 100))
        occupied = {(min(5, int(item["x"] / 6.1 * 6)), min(7, int(item["y"] / 13.4 * 8))) for item in tracks}
        coverage = min(100.0, len(occupied) / 48 * 100)
        duration_minutes = max(effective_duration / 60, 0.1)
        metrics = {
            "distance": round(distance, 1),
            "coverage": round(coverage, 1),
            "left_ratio": round(left_ratio, 1),
            "right_ratio": round(100 - left_ratio, 1),
            "return_efficiency": round(float(return_efficiency), 1),
            "movement_pace": round(distance / duration_minutes, 1),
            "valid_track_ratio": round(min(100, len(tracks) / max(expected_samples, 1) * 100), 1),
        }

        heatmap = [[0 for _ in range(6)] for _ in range(8)]
        for item in tracks:
            column = min(5, int(item["x"] / 6.1 * 6))
            row = min(7, int(item["y"] / 13.4 * 8))
            heatmap[row][column] += 1

        rallies = []
        segment = 30
        for index, start in enumerate(np.arange(segment_start, segment_end, segment)):
            end = min(segment_end, start + segment)
            rallies.append(
                {
                    "id": index + 1,
                    "start": round(float(start), 1),
                    "end": round(float(end), 1),
                    "label": f"训练片段 {index + 1:02d}",
                }
            )

        slim_tracks = compress_tracks(tracks)
        result = {
            "id": uuid.uuid4().hex,
            "analysis_id": None,
            "video_id": video_id,
            "video": meta,
            "player_side": player_side,
            "calibration": points,
            "calibration_id": calibration["calibration_id"],
            "calibration_version": calibration["version"],
            "tracks": slim_tracks,
            "heatmap": heatmap,
            "rallies": rallies,
            "metrics": metrics,
            "advice": build_advice(metrics, slim_tracks),
            "quality": {
                "label": "视觉基线分析",
                "confidence": round(float(np.mean([item["confidence"] for item in tracks])), 2),
                "sampled_frames": sampled,
                "accepted_frames": len(tracks),
                "average_confidence": round(float(np.mean([item["confidence"] for item in tracks])), 2),
                "failure_reason": None,
                "note": "跑位轨迹来自固定机位运动检测；姿态关键点由独立 MediaPipe 接口生成；当前版本未启用羽球轨迹。",
            },
            "runtime": {
                "engine": MODEL_VERSION,
                "gpu_available": bool(torch is not None and torch.cuda.is_available()),
                "gpu_name": torch.cuda.get_device_name(0) if torch is not None and torch.cuda.is_available() else None,
                "sample_interval": 0.5,
            },
            "segment": {
                "start": round(segment_start, 3),
                "duration": round(effective_duration, 3),
                "end": round(segment_end, 3),
            },
            "source": "computed",
            "model_version": MODEL_VERSION,
            "rule_version": RULE_VERSION,
            "schema_version": SCHEMA_VERSION,
            "file_fingerprint": fingerprint,
            "created_at": time.time(),
        }

        analysis_id = result["id"]
        result["analysis_id"] = analysis_id
        result_path = RESULT_DIR / f"{analysis_id}.json"
        result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        with DB_LOCK, db() as connection:
            connection.execute(
                """
                INSERT INTO analyses(
                    id, video_id, result_json, created_at, model_version,
                    rule_version, source, schema_version, file_fingerprint,
                    player_side, calibration_id, segment_start,
                    segment_duration, cache_valid
                )
                VALUES(?, ?, ?, ?, ?, ?, 'computed', ?, ?, ?, ?, ?, ?, 1)
                """,
                (
                    analysis_id,
                    video_id,
                    json.dumps(result, ensure_ascii=False),
                    result["created_at"],
                    MODEL_VERSION,
                    RULE_VERSION,
                    SCHEMA_VERSION,
                    fingerprint,
                    player_side,
                    calibration["calibration_id"],
                    segment_start,
                    effective_duration,
                ),
            )
        update_job(
            job_id,
            status="completed",
            progress=100,
            message="分析完成",
            analysis_id=analysis_id,
            source="computed",
        )
    except Exception as exc:
        update_job(
            job_id,
            status="failed",
            progress=100,
            message="分析失败",
            error=str(exc),
        )


@app.post("/api/analyses")
def create_analysis(payload: AnalysisPayload) -> dict[str, Any]:
    path = video_path(payload.video_id)
    if payload.player_side not in {"near", "far"}:
        raise HTTPException(status_code=400, detail="球员侧必须是 near 或 far")
    meta = probe_video(path)
    segment_start = min(payload.start, max(meta["duration"], 0))
    segment_duration = (
        min(payload.duration, max(0.0, meta["duration"] - segment_start))
        if payload.duration is not None and meta["duration"] > 0
        else max(0.0, meta["duration"] - segment_start)
    )
    if segment_duration < MIN_ANALYSIS_SEGMENT_SECONDS:
        raise HTTPException(status_code=400, detail="分析片段不能短于 5 秒")
    if segment_duration > MAX_ANALYSIS_SEGMENT_SECONDS:
        raise HTTPException(status_code=400, detail="分析片段不能超过 30 分钟")
    calibration = calibration_for(payload.video_id)
    if payload.calibration_id and payload.calibration_id != calibration["calibration_id"]:
        raise HTTPException(status_code=409, detail="标定版本已变化，请刷新后重试")
    fingerprint = meta["file_fingerprint"]
    job_id = uuid.uuid4().hex
    now = time.time()
    with DB_LOCK, db() as connection:
        cached = None
        if not payload.force_recompute:
            cached = connection.execute(
                """
                SELECT id FROM analyses
                WHERE video_id = ?
                  AND file_fingerprint = ?
                  AND player_side = ?
                  AND COALESCE(calibration_id, '') = COALESCE(?, '')
                  AND ABS(segment_start - ?) < 0.001
                  AND ABS(segment_duration - ?) < 0.001
                  AND model_version = ?
                  AND rule_version = ?
                  AND schema_version = ?
                  AND cache_valid = 1
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (
                    payload.video_id,
                    fingerprint,
                    payload.player_side,
                    calibration["calibration_id"],
                    segment_start,
                    segment_duration,
                    MODEL_VERSION,
                    RULE_VERSION,
                    SCHEMA_VERSION,
                ),
            ).fetchone()
        connection.execute(
            """
            INSERT INTO jobs(
                id, video_id, player_side, status, progress, message,
                analysis_id, created_at, updated_at, source, start, duration
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                payload.video_id,
                payload.player_side,
                "completed" if cached else "queued",
                100 if cached else 1,
                "使用缓存分析结果" if cached else "正在启动分析",
                cached["id"] if cached else None,
                now,
                now,
                "cache" if cached else "computed",
                segment_start,
                segment_duration,
            ),
        )
    if cached:
        return {
            "job_id": job_id,
            "analysis_id": cached["id"],
            "status": "completed",
            "source": "cache",
        }
    worker = threading.Thread(
        target=analyse_video,
        args=(
            job_id,
            payload.video_id,
            payload.player_side,
            segment_start,
            segment_duration,
            fingerprint,
            calibration["calibration_id"],
        ),
        daemon=True,
        name=f"analysis-{job_id[:6]}",
    )
    worker.start()
    return {
        "job_id": job_id,
        "analysis_id": None,
        "status": "queued",
        "source": "computed",
    }


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    with db() as connection:
        row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="任务不存在")
    return dict(row)


@app.get("/api/analyses/{analysis_id}")
def get_analysis(analysis_id: str) -> JSONResponse:
    with db() as connection:
        row = connection.execute(
            "SELECT * FROM analyses WHERE id = ?", (analysis_id,)
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="分析结果不存在")
    result = json.loads(row["result_json"])
    result["id"] = analysis_id
    result["analysis_id"] = analysis_id
    result["video_id"] = row["video_id"]
    result.setdefault("source", row["source"] or "computed")
    result.setdefault("model_version", row["model_version"] or "legacy")
    result.setdefault("rule_version", row["rule_version"] or "legacy")
    result.setdefault("schema_version", row["schema_version"] or "1")
    return JSONResponse(result)


@app.delete("/api/videos/{video_id}/cache")
def clear_video_cache(video_id: str) -> dict[str, Any]:
    video_path(video_id)
    pose_files_removed = 0
    for cache_path in POSE_DIR.glob("*.json"):
        try:
            payload = json.loads(cache_path.read_text(encoding="utf-8"))
            if payload.get("video_id") == video_id:
                cache_path.unlink()
                pose_files_removed += 1
        except (OSError, json.JSONDecodeError):
            continue
    with DB_LOCK, db() as connection:
        cursor = connection.execute(
            "UPDATE analyses SET cache_valid = 0 WHERE video_id = ? AND cache_valid = 1",
            (video_id,),
        )
    return {
        "video_id": video_id,
        "pose_files_removed": pose_files_removed,
        "analysis_results_invalidated": cursor.rowcount,
        "historical_reports_preserved": True,
    }
