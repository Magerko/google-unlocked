"""Распознавание картинок reCAPTCHA v2 локальными нейросетями (ONNX).

Модели и пороги взяты из расширения «Free AI ReCaptcha Solver by Raptor»:
- type.onnx — оценивает одну плитку 100×100 (задания 3×3);
- grid.onnx — оценивает цельную картинку 450×450 сразу по 16 клеткам (задания 4×4).
"""
import base64
import io
import json
import logging
import os
import re
import threading

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# Номер выхода модели type.onnx для каждого типа объектов
TYPE_INDEX = {
    "boats": 0, "motorcycles": 1, "palm": 2, "parkingmeter": 3, "stairs": 4, "taxi": 5, "tractors": 6,
    "bicycles": 7, "cars": 8, "hydrants": 9, "crosswalks": 10, "buses": 11, "trafficlights": 12,
    "bridges": 13, "chimney": 14, "mountains": 15,
}

# Пороги уверенности для модели type.onnx
TYPE_THRESHOLDS = {
    "hydrants": 0.144, "bridges": 0.629, "boats": 0.13, "cars": 0.205, "crosswalks": 0.61, "taxi": 0.386,
    "bicycles": 0.423, "trafficlights": 0.331, "motorcycles": 0.273, "stairs": 0.168, "mountains": 0.25,
    "tractors": 0.39, "buses": 0.535, "palm": 0.446, "parkingmeter": 0.126, "chimney": 0.222,
}
DEFAULT_THRESHOLD = 0.5

# Как тип объекта называется в тексте задания. Капча показывается на языке сайта,
# поэтому ищем по началу слова на русском, украинском и английском.
LABEL_PATTERNS = [
    ("crosswalks", r"пешеходн|перех[оі]д|crosswalk"),
    ("trafficlights", r"светофор|св[іi]тлофор|traffic"),
    ("hydrants", r"гидрант|г[іi]дрант|hydrant"),
    ("motorcycles", r"мотоцикл|motorcycle"),
    ("bicycles", r"велосипед|bicycle"),
    ("buses", r"автобус|\bbus"),
    ("cars", r"автомобил|машин|\bcars?\b"),
    ("taxi", r"такс[иі]|taxi"),
    ("tractors", r"трактор|tractor"),
    ("stairs", r"лестниц|сход|stair"),
    ("chimney", r"труб|димар|chimney"),
    ("parkingmeter", r"паркомат|парковочн|parking"),
    ("bridges", r"\bмост|bridge"),
    ("boats", r"лодк|лодок|катер|човн|boat"),
    ("palm", r"пальм|palm"),
    ("mountains", r"\bгор[ыаи]?\b|холм|пагорб|mountain|hill"),
]


def label_from_task(task: str) -> str | None:
    """Тип объекта по тексту задания («Выберите все изображения, где есть автобусы» -> buses)."""
    text = task.lower()
    for label, pattern in LABEL_PATTERNS:
        if re.search(pattern, text):
            return label
    return None


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def _to_tensor(img: Image.Image, size: int) -> np.ndarray:
    img = img.convert("RGB").resize((size, size), Image.BILINEAR)
    arr = (np.asarray(img, dtype=np.float32) / 255.0 - MEAN) / STD
    return arr.transpose(2, 0, 1)


def decode_image(b64: str) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(b64)))


def split_3x3(img: Image.Image) -> list[Image.Image]:
    w, h = img.size
    tw, th = w // 3, h // 3
    return [img.crop((c * tw, r * th, (c + 1) * tw, (r + 1) * th)) for r in range(3) for c in range(3)]


class Recognizer:
    """Загружает модели при первом обращении. Один экземпляр на программу, потокобезопасен."""

    def __init__(self, models_dir: str):
        self.models_dir = models_dir
        self._lock = threading.Lock()
        self._type_session = None
        self._grid_session = None
        self._grid_meta = None

    def available(self) -> bool:
        return all(
            os.path.isfile(os.path.join(self.models_dir, name))
            for name in ("type.onnx", "grid.onnx", "grid.meta.json")
        )

    def _load(self):
        with self._lock:
            if self._type_session is not None:
                return
            import onnxruntime as ort

            options = ort.SessionOptions()
            options.intra_op_num_threads = 2
            options.log_severity_level = 3
            providers = ["CPUExecutionProvider"]
            self._grid_session = ort.InferenceSession(os.path.join(self.models_dir, "grid.onnx"), options, providers=providers)
            with open(os.path.join(self.models_dir, "grid.meta.json"), encoding="utf-8") as f:
                self._grid_meta = json.load(f)
            self._type_session = ort.InferenceSession(os.path.join(self.models_dir, "type.onnx"), options, providers=providers)
            logger.info("Модели распознавания капчи загружены")

    def tiles(self, label: str, tiles: list[Image.Image]) -> tuple[list[bool], list[float]]:
        """Отдельные плитки 100×100: для каждой — есть ли на ней объект."""
        self._load()
        idx = TYPE_INDEX[label]
        batch = np.stack([_to_tensor(t, 100) for t in tiles])
        logits = self._type_session.run(None, {"input": batch})[0]
        probs = _sigmoid(logits[:, idx])
        threshold = TYPE_THRESHOLDS.get(label, DEFAULT_THRESHOLD)
        return [bool(p > threshold) for p in probs], [float(p) for p in probs]

    def grid_4x4(self, label: str, img: Image.Image) -> tuple[list[bool], list[float]] | None:
        """Цельная картинка 4×4: какие из 16 клеток заняты объектом. None, если модель не знает этот тип."""
        self._load()
        meta = self._grid_meta
        idx = meta["type_to_index"].get(label)
        thresholds = meta["thresholds_by_type"].get(label)
        if idx is None or not thresholds:
            return None
        size = int(meta.get("image_size", 450))
        logits = self._grid_session.run(None, {"input": _to_tensor(img, size)[None]})[0]
        probs = _sigmoid(logits[0, idx])
        selected = [bool(p > t) for p, t in zip(probs, thresholds)]

        # Объект на 4×4 почти всегда занимает больше одной клетки: к единственной добавляем вторую по уверенности
        if sum(selected) == 1:
            first = selected.index(True)
            best = max((i for i in range(16) if i != first), key=lambda i: probs[i])
            selected[best] = True
        return selected, [float(p) for p in probs]
