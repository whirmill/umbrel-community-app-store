import contextlib,io,json,unittest
import pathlib,sys
sys.path.insert(0,str(pathlib.Path(__file__).parents[1]))
import lightningmate_native_reader as reader

class SelectedRecord(reader.Docker):
    def __init__(self,raw):super().__init__(reader.Budget());self.raw=raw;self.caps=[];self.calls=[]
    def command(self,args,cap=16384):
        self.calls.append(args);self.caps.append(cap)
        if len(self.raw)>cap:raise reader.Refusal('command_cap')
        return self.raw

class ParserTests(unittest.TestCase):
    def test_single_record_normal_whitespace_and_embedded_equals_newline(self):
        encoded=json.dumps('APP_PASSWORD= SYNTHETIC=VALUE\n ').encode()
        for prefix,suffix in [(b'',b''),(b'',b'\n'),(b'',b'\n\n'),(b' \t\n',b'\r\n \t')]:
            with self.subTest(prefix=prefix,suffix=suffix):
                native=SelectedRecord(prefix+encoded+suffix);capture=io.StringIO()
                with contextlib.redirect_stdout(capture),contextlib.redirect_stderr(capture):value=native.password()
                self.assertEqual(value,'SYNTHETIC=VALUE');self.assertEqual(capture.getvalue(),'')
                self.assertEqual(native.caps,[8192]);self.assertEqual(len(native.calls),1)
                self.assertNotIn('APP_SEED',native.calls[0][2])
    def test_multiple_records_trailing_content_and_invalid_shapes_refused(self):
        record=json.dumps('APP_PASSWORD=SYNTHETIC').encode()
        cases=[record+b'\n'+record,record+record,record+b' trailing',b'',b' \n\t',b'"unterminated',b'\xff',b'null',b'true',b'42',b'{}',b'[]',b'"OTHER=SYNTHETIC"',b'"APP_PASSWORD= \t"',json.dumps('APP_PASSWORD=   ').encode()]
        for raw in cases:
            with self.subTest(raw=raw):
                capture=io.StringIO()
                with contextlib.redirect_stdout(capture),contextlib.redirect_stderr(capture):
                    with self.assertRaisesRegex(reader.Refusal,'^configured_reference$'):SelectedRecord(raw).password()
                self.assertEqual(capture.getvalue(),'')
    def test_existing_secret_and_command_byte_caps_preserved(self):
        for count in [1,4096]:self.assertEqual(len(SelectedRecord(json.dumps('APP_PASSWORD='+'x'*count).encode()).password()),count)
        with self.assertRaisesRegex(reader.Refusal,'configured_reference'):SelectedRecord(json.dumps('APP_PASSWORD='+'x'*4097).encode()).password()
        with self.assertRaisesRegex(reader.Refusal,'command_cap'):SelectedRecord(b'x'*8193).password()
        with self.assertRaisesRegex(reader.Refusal,'command_cap'):SelectedRecord(json.dumps('APP_PASSWORD=x').encode()+b' '*8192).password()

if __name__=='__main__':unittest.main()
