import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('fetch_asset', Path(__file__).parents[1] / 'fetch_asset.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)

class AssetTests(unittest.TestCase):
    def test_byte_and_hash_bounds_leave_no_partial_or_replaced_asset(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'asset'
            for body, size, sha in [(b'oversized', 4, 'a'*64), (b'abc', 4, 'a'*64), (b'abcd', 4, 'a'*64)]:
                with self.assertRaises(ValueError):
                    a.fetch(path, 'https://invalid.test', size, sha, opener=lambda *_args, **_kwargs: io.BytesIO(body))
                self.assertEqual(list(Path(directory).iterdir()), [])
            a.fetch(path, 'https://invalid.test', 4, hashlib.sha256(b'abcd').hexdigest(), opener=lambda *_args, **_kwargs: io.BytesIO(b'abcd'))
            self.assertEqual(path.read_bytes(), b'abcd')
            self.assertEqual(path.stat().st_mode & 0o777, 0o444)
    def test_asset_registry_is_fully_immutable_and_multilingual(self):
        self.assertEqual(len(a.ASSETS), 3)
        model = a.ASSETS['ggml-base.bin']
        self.assertIn('/5359861c739e955e79d9a303bcbc70fb988958b1/', model[0])
        self.assertEqual(model[1], 147951465)
        self.assertEqual(model[2], '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe')

if __name__ == '__main__':
    unittest.main()
