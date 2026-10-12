import json
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
import alby_transport
from test_alby_readonly import AT, QUALIFICATION, responses, token

CONFIG = {'scheme':'http','host':'127.0.0.1','port':8080,'sourceHash':'a'*64,'jwtFile':'/etc/qualified/jwt'}


class Response:
    def __init__(self, body, status=200, headers=None):
        self.body, self.status, self.headers = body, status, headers or {'Content-Type':'application/json'}
    def close(self): self.closed=True
    def getheader(self, name, default=None): return self.headers.get(name,default)
    def read1(self, size):
        value,self.body=self.body[:size],self.body[size:]
        return value


class Connection:
    def __init__(self, response): self.response=response;self.closed=False;self.calls=[]
    def request(self, method, route, headers): self.calls.append((method,route))
    def getresponse(self): return self.response
    def close(self): self.closed=True


class AlbyTransportTests(unittest.TestCase):
    def test_three_authenticated_gets_close_and_sanitized_exact_binding(self):
        connections=[]
        def factory(timeout):
            route=alby_transport.alby_readonly.ROUTES[len(connections)]
            connection=Connection(Response(json.dumps(responses()[route]).encode()));connections.append(connection);return connection
        q=QUALIFICATION | {'expectedBackend':'lnd','expectedNodeId':'02'+'1'*64,'expectedAutoSwapOutEnabled':False}
        with patch.object(alby_transport.host_read_boundary,'read_bytes',return_value=token().encode()):
            result=alby_transport.qualify(CONFIG,q,lambda:AT,factory)
        self.assertFalse(result['autoSwapOutEnabled'])
        self.assertTrue(all(c.closed for c in connections))
        self.assertEqual([c.calls for c in connections],[[('GET',r)] for r in alby_transport.alby_readonly.ROUTES])
        self.assertNotIn('SYNTHETIC',json.dumps(result))

    def test_no_redirects_overcaps_errors_bad_json_or_extra_gets(self):
        for response in [Response(b'SYNTHETIC_PRIVATE',302),Response(b'{}',headers={'Content-Type':'application/json','Content-Length':'999999'}),Response(b'x'*65537),Response(b'{"exp":NaN}'),Response(b'SYNTHETIC_PRIVATE',401),Response(b'[]')]:
            connection=Connection(response);transport=alby_transport.AlbyTransport(CONFIG,connection_factory=lambda _:connection)
            with self.assertRaisesRegex(ValueError,'^Alby finite read unavailable$'): transport.read_get('/api/info',token())
            self.assertTrue(connection.closed)
        transport=alby_transport.AlbyTransport(CONFIG,connection_factory=lambda _:Connection(Response(b'{}')))
        with self.assertRaises(ValueError): transport.read_get('/api/unlock',token())
        for _ in range(3): transport.read_get('/api/info',token())
        with self.assertRaises(ValueError): transport.read_get('/api/info',token())

    def test_network_scheme_and_tls_identity_are_required(self):
        for changed in [{'scheme':'http','host':'10.0.0.1'},{'scheme':'ftp'},{'host':'example.com'},{'scheme':'https','serverName':'bad/name'},{'port':True}]:
            with self.assertRaises(ValueError): alby_transport.AlbyTransport(CONFIG|changed)

    def test_deadline_stops_and_releases_connection(self):
        ticks=iter([0,1,31]);connection=Connection(Response(b'{}'))
        transport=alby_transport.AlbyTransport(CONFIG,clock=lambda:next(ticks),connection_factory=lambda _:connection)
        with self.assertRaises(ValueError): transport.read_get('/api/info',token())
        self.assertTrue(connection.closed)

    def test_expected_node_backend_and_auto_state_must_match(self):
        for expected in [{'expectedNodeId':'03'+'2'*64},{'expectedBackend':'ldk'},{'expectedAutoSwapOutEnabled':True}]:
            q=QUALIFICATION|{'expectedBackend':'lnd','expectedNodeId':'02'+'1'*64,'expectedAutoSwapOutEnabled':False}|expected
            route_index=[]
            def factory(timeout):
                route=alby_transport.alby_readonly.ROUTES[len(route_index)];route_index.append(route)
                return Connection(Response(json.dumps(responses()[route]).encode()))
            with patch.object(alby_transport.host_read_boundary,'read_bytes',return_value=token().encode()):
                with self.assertRaisesRegex(ValueError,'^Alby protected native qualification unavailable$'): alby_transport.qualify(CONFIG,q,lambda:AT,factory)

    def test_tls_sni_certificate_pin_and_failure_close(self):
        import hashlib
        import ssl
        class Socket:
            def __init__(self): self.closed=False
            def close(self): self.closed=True
            def settimeout(self, timeout): pass
            def getpeercert(self,binary_form=False): return b'qualified-certificate'
        class Context:
            def __init__(self,socket): self.socket=socket;self.names=[]
            def wrap_socket(self,raw,server_hostname): self.names.append(server_hostname);return self.socket
        for fingerprint in [hashlib.sha256(b'qualified-certificate').hexdigest(),'f'*64]:
            raw=Socket();wrapped=Socket();context=Context(wrapped)
            connection=alby_transport.PinnedHTTPS('127.0.0.1',8080,ssl.create_default_context(),'qualified.local',fingerprint,1)
            connection._context=context
            with patch.object(alby_transport.socket,'create_connection',return_value=raw):
                if fingerprint=='f'*64:
                    with self.assertRaises(ValueError):connection.connect()
                    self.assertTrue(raw.closed);self.assertTrue(wrapped.closed)
                else:
                    connection.connect();self.assertEqual(context.names,['qualified.local']);connection.close();self.assertTrue(wrapped.closed)

    def test_tls_context_does_not_honor_keylog_or_ca_environment(self):
        import os
        import ssl
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            marker=str(pathlib.Path(directory)/'unreviewed-keylog')
            config=CONFIG|{'scheme':'https','serverName':'qualified.local','certificateSha256':'a'*64,'caFile':'/root/qualified-ca'}
            with patch.dict(os.environ,{'SSLKEYLOGFILE':marker,'SSL_CERT_FILE':'/unreviewed/ca'}),patch.object(alby_transport.host_read_boundary,'read_bytes',return_value=b'fixture-ca'),patch.object(ssl.SSLContext,'load_verify_locations'):
                transport=alby_transport.AlbyTransport(config)
                self.assertTrue(transport.context.check_hostname)
                self.assertEqual(transport.context.verify_mode,ssl.CERT_REQUIRED)
                self.assertIsNone(transport.context.keylog_filename)
                transport.close()
            self.assertFalse(pathlib.Path(marker).exists())

    def test_missing_source_backend_node_or_automation_binding_reads_no_credential(self):
        q=QUALIFICATION|{'expectedBackend':'lnd','expectedNodeId':'02'+'1'*64,'expectedAutoSwapOutEnabled':False}
        for key in ['contract','sourceHash','expectedBackend','expectedNodeId','expectedAutoSwapOutEnabled']:
            incomplete={k:v for k,v in q.items() if k!=key}
            with patch.object(alby_transport.host_read_boundary,'read_bytes',side_effect=AssertionError('No credential read')):
                with self.assertRaises(ValueError):alby_transport.qualify(CONFIG,incomplete,lambda:AT)


class RealDeadlineTests(unittest.TestCase):
    def exercise(self, parts, *, tls=False, success=False):
        import socket
        import ssl
        import threading
        import time
        listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(1);listener.settimeout(1)
        port=listener.getsockname()[1];stop=threading.Event();errors=[]
        def server():
            try:
                with listener.accept()[0] as peer:
                    peer.settimeout(1);peer.recv(16384)
                    for data, delay in parts:
                        for byte in data:
                            if stop.is_set(): return
                            peer.sendall(bytes([byte]))
                            if delay and stop.wait(delay): return
                    stop.wait(1)
            except (BrokenPipeError,ConnectionResetError): pass
            except Exception as exc: errors.append(type(exc).__name__)
        thread=threading.Thread(target=server);thread.start()
        transport=alby_transport.AlbyTransport(CONFIG|{'port':port})
        if tls:
            transport.context=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            transport.config=transport.config|{'serverName':'qualified.local','certificateSha256':'a'*64}
        start=time.monotonic();transport.deadline=start+0.30
        try:
            if success: self.assertEqual(transport.read_get('/api/info','fixture'),{})
            else:
                with self.assertRaisesRegex(ValueError,'^Alby finite read unavailable$'):
                    transport.read_get('/api/info','fixture')
                self.assertGreater(time.monotonic()-start,0.20)
                self.assertLess(time.monotonic()-start,0.55)
            self.assertIsNone(transport.active)
        finally:
            transport.close();stop.set();listener.close();thread.join(2)
        self.assertFalse(thread.is_alive(),'fixture thread must be reaped')
        self.assertEqual(errors,[])

    def test_real_trickling_headers_obey_absolute_deadline(self):
        self.exercise([(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Slow: ',0),(b'x'*100,0.02)])

    def test_real_trickling_body_obeys_absolute_deadline(self):
        self.exercise([(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n',0),(b'x'*100,0.02)])

    def test_real_trickling_chunk_trailer_obeys_absolute_deadline(self):
        self.exercise([(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\nX-Slow: ',0),(b'x'*100,0.02)])

    def test_real_slow_tls_handshake_obeys_absolute_deadline(self):
        self.exercise([(b'\x16\x03\x03\x00\x64',0),(b'\x02\x00\x00\x60'+b'\x00'*96,0.02)],tls=True)

    def test_real_success_closes_parser_and_connection(self):
        self.exercise([(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}',0)],success=True)
