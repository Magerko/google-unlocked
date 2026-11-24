import base64
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import unittest

from PIL import Image
from host import handle


class HostTests(unittest.TestCase):
    def test_models_and_real_inference(self):
        self.assertTrue(handle({'kind': 'ping'})['models'])
        stream = io.BytesIO()
        Image.new('RGB', (450, 450)).save(stream, format='PNG')
        data = base64.b64encode(stream.getvalue()).decode()
        for kind, count in [('3x3', 9), ('4x4', 16), ('tiles', 1)]:
            result = handle({'kind': kind, 'task': 'Select all images with buses', 'images': [data]})
            self.assertEqual(len(result['selected']), count)
            self.assertTrue(all(isinstance(value, bool) for value in result['selected']))

    def test_unknown_task(self):
        with self.assertRaises(ValueError):
            handle({'kind': '3x3', 'task': 'unknown object', 'images': []})

    def test_native_protocol_multiple_messages(self):
        messages = [json.dumps({'id': i, 'task': 'unknown'}).encode() for i in (1, 2)]
        payload = b''.join(struct.pack('<I', len(msg)) + msg for msg in messages)
        output = subprocess.run([sys.executable, str(Path(__file__).with_name('host.py'))],
                                input=payload, capture_output=True, timeout=30, check=True).stdout
        for i in (1, 2):
            size = struct.unpack('<I', output[:4])[0]
            result = json.loads(output[4:4 + size])
            self.assertEqual(result['id'], i)
            self.assertIn('error', result)
            output = output[4 + size:]
        self.assertEqual(output, b'')


if __name__ == '__main__':
    unittest.main()
