"""Browser native messaging host. No network listener or remote inference."""
import json
import os
from pathlib import Path
import struct
import sys

from captcha_recognizer import Recognizer, decode_image, label_from_task, split_3x3

recognizer = Recognizer(str(Path(__file__).parent / 'models'))


def handle(message):
    if message.get('kind') == 'ping':
        recognizer._load()
        return {'ok': True, 'models': recognizer.available()}
    label = label_from_task(message.get('task', '')[:500])
    if not label:
        raise ValueError('Неподдерживаемый тип задания')
    images = message.get('images', [])
    kind = message.get('kind')
    if kind not in ('3x3', '4x4', 'tiles') or not 1 <= len(images) <= 9:
        raise ValueError('Некорректное задание')
    decoded = [decode_image(data) for data in images]
    if any(im.width > 2048 or im.height > 2048 for im in decoded):
        raise ValueError('Слишком большое изображение')
    if kind == '4x4':
        result = recognizer.grid_4x4(label, decoded[0])
    else:
        result = recognizer.tiles(label, split_3x3(decoded[0]) if kind == '3x3' else decoded)
    if result is None:
        raise ValueError('Модель не поддерживает это задание 4×4')
    return {'selected': result[0]}


def read_exact(stream, size):
    result = bytearray()
    while len(result) < size:
        part = stream.read(size - len(result))
        if not part:
            raise EOFError()
        result.extend(part)
    return bytes(result)


def main():
    if os.name == 'nt':
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    while True:
        try:
            size = struct.unpack('<I', read_exact(sys.stdin.buffer, 4))[0]
            if size > 8 * 1024 * 1024:
                return
            message = json.loads(read_exact(sys.stdin.buffer, size))
        except EOFError:
            return
        try:
            answer = handle(message)
        except Exception as exc:
            answer = {'error': str(exc)}
        answer['id'] = message.get('id')
        data = json.dumps(answer).encode('utf-8')
        sys.stdout.buffer.write(struct.pack('<I', len(data)) + data)
        sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()
