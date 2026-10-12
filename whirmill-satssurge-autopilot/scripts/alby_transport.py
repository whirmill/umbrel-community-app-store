"""Concrete bounded Alby GET transport; no proxy/env loaders or redirects.

The root caller supplies reviewed endpoint/image/source/node bindings and a
protected credential PATH. This module never emits or persists credential/body.
"""
import hashlib
import http.client
import ipaddress
import io
import json
import pathlib
import re
import socket
import ssl
import time

import alby_readonly
import host_read_boundary


class DeadlineReader(io.RawIOBase):
    """Every parser refill uses the same absolute acquisition deadline."""
    def __init__(self, owner):
        super().__init__()
        self.owner = owner
        owner.readers += 1
    def readable(self): return True
    def readinto(self, buffer):
        self.owner.prepare()
        count = self.owner.raw.recv_into(buffer)
        self.owner.check()
        return count
    def close(self):
        if not self.closed:
            self.owner.readers -= 1
            self.owner.release()
        super().close()


class DeadlineSocket:
    # HTTPResponse can retain its file after HTTPConnection.close(). Keep the
    # socket until both the connection and its parser file have released it.
    def __init__(self, raw, deadline, clock):
        self.raw, self.deadline, self.clock = raw, deadline, clock
        self.readers, self.closed = 0, False
    def check(self):
        if self.clock() >= self.deadline: raise TimeoutError('Alby deadline')
    def prepare(self):
        remaining = self.deadline - self.clock()
        if remaining <= 0: raise TimeoutError('Alby deadline')
        self.raw.settimeout(min(3, remaining))
    def sendall(self, data):
        self.prepare()
        self.raw.sendall(data)
        self.check()
    def makefile(self, mode, buffering=None):
        if mode != 'rb': raise ValueError('Alby parser mode')
        return io.BufferedReader(DeadlineReader(self))
    def settimeout(self, timeout): self.prepare()
    def release(self):
        if self.closed and not self.readers: self.raw.close()
    def close(self):
        self.closed = True
        self.release()


class DeadlineHTTP(http.client.HTTPConnection):
    def __init__(self, host, port, timeout, deadline, clock):
        super().__init__(host, port, timeout=timeout)
        self.deadline, self.clock = deadline, clock
    def connect(self):
        remaining = self.deadline - self.clock()
        if remaining <= 0: raise TimeoutError('Alby deadline')
        raw = socket.create_connection((self.host, self.port), min(3, remaining))
        self.sock = DeadlineSocket(raw, self.deadline, self.clock)
        self.sock.check()


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, port, context, name, fingerprint, timeout, deadline=None, clock=time.monotonic):
        super().__init__(host, port, context=context, timeout=timeout)
        self.name, self.fingerprint = name, fingerprint
        self.clock, self.deadline = clock, deadline if deadline is not None else clock() + timeout
    def connect(self):
        raw = wrapped = None
        try:
            remaining = self.deadline - self.clock()
            if remaining <= 0: raise TimeoutError('Alby deadline')
            raw = socket.create_connection((self.host, self.port), min(3, remaining))
            remaining = self.deadline - self.clock()
            if remaining <= 0: raise TimeoutError('Alby deadline')
            raw.settimeout(min(3, remaining))
            # Python's blocking TLS handshake timeout bounds the whole handshake,
            # not each incoming record. Subsequent HTTP parser reads use our IO.
            wrapped = self._context.wrap_socket(raw, server_hostname=self.name)
            self.sock = DeadlineSocket(wrapped, self.deadline, self.clock)
            self.sock.check()
            if hashlib.sha256(wrapped.getpeercert(binary_form=True)).hexdigest() != self.fingerprint:
                raise ValueError('Certificate mismatch')
        except BaseException:
            if wrapped: wrapped.close()
            if raw: raw.close()
            self.close()
            raise


class AlbyTransport:
    def __init__(self, config, clock=time.monotonic, connection_factory=None):
        # No arbitrary URI, hostname resolution, URL credential or proxy selection.
        host = config.get('host')
        address = ipaddress.ip_address(host)
        if type(config.get('port')) is not int or not 1 <= config['port'] <= 65535:
            raise ValueError('Alby endpoint unqualified')
        if config.get('scheme') == 'http':
            if not address.is_loopback:
                raise ValueError('Local loopback HTTP required')
            context = None
        elif config.get('scheme') == 'https':
            if not re.fullmatch(r'[A-Za-z0-9.-]{1,253}', config.get('serverName', '')) or not re.fullmatch(r'[a-f0-9]{64}', config.get('certificateSha256', '')):
                raise ValueError('Alby TLS identity required')
            ca = host_read_boundary.read_bytes(pathlib.Path(config['caFile']), 1048576, protected=True).decode()
            # Avoid SSLKEYLOGFILE/default-CA environment behavior entirely.
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.load_verify_locations(cadata=ca)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
        else:
            raise ValueError('Alby scheme unqualified')
        self.config, self.context, self.clock, self.factory = config, context, clock, connection_factory
        self.deadline = clock() + 30
        self.active = None
        self.requests = 0

    def read_get(self, route, jwt):
        if route not in alby_readonly.ROUTES or self.requests >= 3:
            raise ValueError('Alby finite read unavailable')
        self.requests += 1
        body = bytearray()
        connection = response = None
        try:
            remaining = self.deadline - self.clock()
            if remaining <= 0: raise ValueError()
            timeout = min(3, remaining)
            if self.factory:
                connection = self.factory(timeout)
            elif self.context:
                connection = PinnedHTTPS(self.config['host'], self.config['port'], self.context,
                    self.config['serverName'], self.config['certificateSha256'], timeout, self.deadline, self.clock)
            else:
                connection = DeadlineHTTP(self.config['host'], self.config['port'], timeout, self.deadline, self.clock)
            self.active = connection
            connection.request('GET', route, headers={'Authorization': 'Bearer ' + jwt, 'Accept': 'application/json', 'Connection': 'close'})
            response = connection.getresponse()
            if response.status != 200 or response.getheader('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
                raise ValueError()
            length = response.getheader('Content-Length')
            if length is not None and (not re.fullmatch(r'\d{1,9}', length) or int(length) > 65536): raise ValueError()
            while len(body) <= 65536:
                remaining = self.deadline - self.clock()
                if remaining <= 0: raise ValueError()
                if getattr(connection, 'sock', None): connection.sock.settimeout(min(3, remaining))
                block = response.read1(min(8192, 65537 - len(body)))
                if not block: break
                body.extend(block)
            if len(body) > 65536 or self.clock() > self.deadline: raise ValueError()
            value = json.loads(body, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if not isinstance(value, dict): raise ValueError()
            return value
        except Exception:
            raise ValueError('Alby finite read unavailable') from None
        finally:
            body[:] = b'\x00' * len(body)
            if response: response.close()
            if connection: connection.close()
            self.active = None

    def close(self):
        if self.active: self.active.close()
        self.active = None
        self.deadline = -1


def qualify(config, qualification, clock=None, connection_factory=None):
    """Read root-protected 0600 JWT internally; never request/return its contents."""
    credential = None
    transport = None
    try:
        if qualification.get('contract') != alby_readonly.CONTRACT or qualification.get('version') != '1.24.0-patch.1' or not re.fullmatch(r'[a-f0-9]{64}', qualification.get('sourceHash','')) or not isinstance(qualification.get('apiVersion'),str) or not qualification['apiVersion'] or qualification.get('expectedBackend') not in ['lnd','ldk'] or not re.fullmatch(r'(02|03)[a-f0-9]{64}',qualification.get('expectedNodeId','')) or type(qualification.get('expectedAutoSwapOutEnabled')) is not bool or config.get('sourceHash') != qualification.get('sourceHash'):
            raise ValueError()
        raw = bytearray(host_read_boundary.read_bytes(pathlib.Path(config['jwtFile']), 8192, protected=True, private=True))
        try: credential = raw.decode('ascii').strip()
        finally: raw[:] = b'\x00' * len(raw)
        transport = AlbyTransport(config, connection_factory=connection_factory)
        kwargs = {'clock': clock} if clock else {}
        facts = alby_readonly.read_facts(transport.read_get, credential, qualification, **kwargs)
        if facts['backend'] != qualification.get('expectedBackend') or facts['nodeId'] != qualification.get('expectedNodeId') or facts['autoSwapOutEnabled'] is not qualification.get('expectedAutoSwapOutEnabled'):
            raise ValueError()
        return facts
    except Exception:
        raise ValueError('Alby protected native qualification unavailable') from None
    finally:
        credential = None
        if transport: transport.close()
