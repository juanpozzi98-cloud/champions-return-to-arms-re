#!/usr/bin/env python3
"""The relay of the browser build: what stands in for the sockets a web page does not have.

A page of the browser build (tools/play-web) opens ONE WebSocket connection to this
program. Through it the emulated console's network (tools/play-net/src/RtaNet.cpp,
compiled into the page) asks for what the desktop application does with sockets of its
own:

  TCP   connections to the lobby server - to the configured lobby host and the configured
        ports only (the gateway port and the lobby port), nothing else; and on them only
        whole lobby requests, as many as the player's address may send ("Limits per
        player address" below);
  UDP   one socket here per UDP port the console uses, kept for the session and used for
        every destination. The lobby server sees a browser player at this host's address
        and that socket's port, exactly as it sees a desktop player's router, and hands
        that address to the other players. A datagram may go to three kinds of
        destination only:
          - the lobby server's discovery port;
          - the UDP socket of another session of this relay (another browser player:
            handed over inside this program), when that page wants to hear from this one:
            the lobby server named this player to it, or it has itself sent to this
            player within the last half minute;
          - a player outside (the desktop application), under the rule below.

Players outside. A datagram passes between a session's socket and an outside address and
port only when that pair is OPEN for the session, and it is opened in two ways only:

  named    the lobby server itself named the address to this player: the relay reads the
           lobby connection as it passes (server to page only) and takes the address the
           server OBSERVED for the host of a listed game (reply 0x55), of a game found by
           name (reply 0x57) or of a player who wants in (notification 0x65). The
           "own-network" addresses in the same messages are what a player claims and are
           not taken. docs/lobby-protocol.md has the messages.
  both     the page has asked to send to the address AND a datagram from that address has
           arrived on the session's socket (in either order, within half a minute). This
           is how the third player of a game is met: the host passes addresses along
           player to player and the lobby server names nobody.

Neither a page nor a stranger can open a path alone: what a page sends to an address that
is not open is dropped (never sent), and what arrives from an address that is not open is
dropped (never shown to a page). Addresses that are not public are left out unless --lan
is given. Open paths are few per session, each has a datagram rate, and one that hears
nothing for two minutes is closed.

So this is not a proxy to anywhere: a page reaches the lobby server, the other pages, and
the players the lobby server put it in a game with.

Limits per player address. The lobby server sees every browser player at this host's
address and cannot tell them apart, so what it limits per address (connections, the
request budget, password checks, accounts created: its SECURITY.md) the relay limits
here, per PLAYER address, with the lobby server's own numbers unless told otherwise:

  - sessions at a time (--per-address) and new sessions a minute (--new-sessions);
  - log-ins and account-detail requests, which are the two requests that check a
    password (lobby messages 0x16 and 0x64): --login-burst at once, one more every
    --login-every seconds;
  - accounts created (0x06): --account-burst at once, one more every --account-every
    seconds;
  - the request budget: every request costs what the lobby server says it costs
    (REQUEST_COST below, from its LobbyServer::RequestCost), --request-burst units at
    once and --request-rate a second.

The length of a lobby request (four bytes, big-endian, counting themselves) and its kind
(the two bytes after, little-endian) are not encrypted - the game encrypts single text
fields, nothing else - so the relay reads those six bytes of each request and nothing
more. It hands the lobby server whole requests only. A log-in or an account over the
allowance is NOT handed on: the connection to the lobby server is closed and the page is
told why (NOTICE, code 8). Requests over the budget wait here, as they would wait at the
lobby server. The allowances belong to the address, not to the session: a page that
connects again finds them as it left them. The player's address is the one this
connection comes from; with --trust-proxy, for connections from this host, it is the
last value of the X-Real-IP line (what the web server in front saw); a request with more
than one such line is turned away. No other header is read: X-Forwarded-For is whatever
the client wrote. An IPv6 player counts by its /64.

    relay.py --lobby 192.0.2.10                        # ws://127.0.0.1:8975/relay
    relay.py --lobby 192.0.2.10 --listen 127.0.0.1:8975 --path /relay \\
             --origin https://play.example --trust-proxy --udp-ports 41000-41999

Python 3.8 or later, standard library only (the WebSocket handshake and framing are
written out below: RFC 6455, binary messages, no extensions). It listens on a loop-back
address by default: put a web server in front for TLS (a page served over https may only
open wss://) and let it hand the connection on (README.md beside this file). The UDP
sockets are on every address of the host: players outside must be able to reach them
(--udp-ports gives the range to open in a firewall).

Messages (one per binary WebSocket message; numbers big-endian):

  page -> relay                               relay -> page
  01 HELLO      u8 version (1)                81 WELCOME    u8 version, u32 lobby address,
  02 TCP_OPEN   u16 id, u32 address, u16 port               u32 this relay's address, u16 idle
  03 TCP_DATA   u16 id, bytes                               seconds, u16 largest message
  04 TCP_SHUT   u16 id   (no more to send)    82 TCP_OPENED u16 id, u8 status (0 connected,
  05 TCP_CLOSE  u16 id                                      1 not allowed, 2 refused, 3 timed
  06 UDP_OPEN   u8 socket                                   out, 4 unreachable, 5 too many)
  07 UDP_SEND   u8 socket, u32 address,       83 TCP_DATA   u16 id, bytes
                u16 port, bytes               84 TCP_EOF    u16 id   (the server sends no more)
  08 UDP_CLOSE  u8 socket                     85 TCP_CLOSED u16 id   (gone)
  09 PING       up to 16 bytes                86 UDP_BOUND  u8 socket, u16 port (here)
                                              87 UDP_RECV   u8 socket, u32 address, u16 port, bytes
                                              89 PONG       the same bytes
                                              8A NOTICE     u8 code, text (why something was
                                                            refused, or why the session ends)

NOTICE codes: 1 the relay is full, 2 too many pages from the address, 3 idle, 4 not the
relay's messages, 5 a destination that is not allowed, 6 more data than a game sends,
7 the relay is stopping, 8 a limit of the player's address (log-ins, accounts, requests,
new sessions): the text says which and how long to wait.
"""
import argparse
import asyncio
import base64
import hashlib
import ipaddress
import signal
import socket
import struct
import sys
import time

VERSION = 1
HELLO, TCP_OPEN, TCP_DATA, TCP_SHUT, TCP_CLOSE, UDP_OPEN, UDP_SEND, UDP_CLOSE, PING = range(1, 10)
WELCOME, TCP_OPENED, R_TCP_DATA, TCP_EOF, TCP_CLOSED, UDP_BOUND, UDP_RECV, PONG, NOTICE = 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x89, 0x8A
OK, NOT_ALLOWED, REFUSED, TIMED_OUT, UNREACHABLE, TOO_MANY = range(6)
# NOTICE codes
N_FULL, N_ADDRESS_FULL, N_IDLE, N_PROTOCOL, N_NOT_ALLOWED, N_TOO_MUCH, N_STOPPING, N_LIMIT = range(1, 9)

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_TCP = 4          # connections of one session at a time (the game has one or two)
MAX_UDP = 8          # UDP sockets of one session (the game uses one of its ports 4000-4004)
WRITE_HIGH = 1 << 18  # bytes waiting for a page before its datagrams are dropped
PAGE_HIGH = 1 << 20  # bytes waiting for a page at which its session is ended: it does not read
LINGER = 10          # seconds a closed session's connection is given to take the goodbye
MAX_HANDSHAKES = 64  # connections that have not finished their WebSocket handshake
MAX_ADDRESSES = 4096  # player addresses whose allowances are kept
# the lobby connection, page to server (docs/lobby-protocol.md section 2; the lobby server's LobbyServer.cpp)
LOBBY_REQUEST = 2048    # the largest request the lobby server takes; a longer one makes it close the connection
REQUESTS_HELD = 131072  # bytes of requests of one connection that may wait here for the address's budget
PASSWORD_CHECKS = (0x16, 0x64)  # log in; account details - the two requests that check a password
CREATE_ACCOUNT = 0x06
KEEP_ALIVE_COST = 0.1   # a request with no payload: the game's keep-alive
# what a request costs its sender's address: LobbyServer::RequestCost. A character upload
# (0x58, 0x5E) costs 3 there and 30 more when its last piece is written to the database;
# the relay does not look into the pieces and charges the write at the start.
REQUEST_COST = {0x06: 20, 0x16: 10, 0x64: 10, 0x5C: 10, 0x01: 5, 0x02: 5, 0x1C: 5, 0x1D: 5, 0x5A: 5, 0x08: 5, 0x09: 5, 0x0A: 5,
                0x54: 5, 0x56: 5, 0x58: 33, 0x5E: 33, 0x5B: 3, 0x21: 2, 0x22: 2}
DISCOVERY_SIZE = 256    # bytes of a datagram for the lobby server's discovery port (the game's has 52)
DISCOVERY_RATE = 10     # of them a second from one session (the game sends six at most)
# players outside (the desktop application): see "Players outside" above
MAX_NAMED = 64       # addresses the lobby server named to one session (a game list names every host)
MAX_ASKED = 16       # outside addresses a page has asked for that have not sent yet
MAX_HEARD = 32       # outside addresses that have sent to a session and were not asked for yet
MAX_PATHS = 16       # open paths of one session (a game has three other players)
NAMED_FOR = 300.0    # seconds an address stays named after the lobby server last named it
MEET_WITHIN = 30.0   # seconds within which asking and hearing have to meet
PATH_SILENT = 120.0  # seconds without a datagram from outside after which a path is closed
MAX_DATAGRAM = 1500  # bytes of one datagram from outside (the game's own are far smaller)
LOBBY_FRAME = 65536  # the largest lobby message that is read for addresses (larger ones pass unread)

# what an address is, for a datagram's destination or source
NEVER, PRIVATE, PUBLIC = range(3)
_NEVER = [(0x00000000, 8), (0x7F000000, 8), (0xE0000000, 4), (0xF0000000, 4)]  # this network, loop-back, multicast, reserved and broadcast
_PRIVATE = [(0x0A000000, 8), (0xAC100000, 12), (0xC0A80000, 16), (0xA9FE0000, 16), (0x64400000, 10),  # private, link-local, carrier NAT
            (0xC0000000, 24), (0xC0000200, 24), (0xC6120000, 15), (0xC6336400, 24), (0xCB007100, 24)]  # set aside for protocols, documents and tests


def address_kind(address):
    for net, bits in _NEVER:
        if (address ^ net) >> (32 - bits) == 0:
            return NEVER
    for net, bits in _PRIVATE:
        if (address ^ net) >> (32 - bits) == 0:
            return PRIVATE
    return PUBLIC


def log(text):
    print(time.strftime("%Y-%m-%d %H:%M:%S ") + text, flush=True)


def ip_int(text):
    return int(ipaddress.IPv4Address(text))


def ip_text(number):
    return str(ipaddress.IPv4Address(number))


class Stop(Exception):
    """The session ends: a NOTICE code and words for the page and the log."""

    def __init__(self, code, text):
        super().__init__(text)
        self.code = code


class Bucket:
    """So many units a second, with a reserve of twice that."""

    def __init__(self, rate):
        self.rate = rate
        self.level = rate * 2.0
        self.at = time.monotonic()

    def take(self, units=1):
        now = time.monotonic()
        self.level = min(self.rate * 2.0, self.level + (now - self.at) * self.rate)
        self.at = now
        if self.level < units:
            return False
        self.level -= units
        return True


class Allowance:
    """So many at once, and so many more a second: the lobby server's own kind of allowance
    (its TokenBucket). It starts full. What is taken may overdraw it: a request is let in
    when one unit is there and is then paid for with what it costs."""

    def __init__(self, most, rate):
        self.most, self.rate = float(most), float(rate)
        self.level = self.most
        self.at = time.monotonic()

    def fill(self):
        now = time.monotonic()
        if now > self.at:
            self.level = min(self.most, self.level + (now - self.at) * self.rate)
            self.at = now

    def has(self, units=1.0):
        self.fill()
        return self.level >= units

    def take(self, units=1.0):
        self.level -= units

    def wait(self, units=1.0):
        """Seconds until so many are there."""
        self.fill()
        if self.level >= units:
            return 0.0
        return min(3600.0, (units - self.level) / self.rate) if self.rate > 0 else 3600.0

    def full(self):
        self.fill()
        return self.level >= self.most


class Address:
    """What is kept for one player address. It outlives the address's sessions: a page that
    connects again finds its allowances as it left them."""

    def __init__(self, args):
        self.sessions = 0
        self.logins = Allowance(args.login_burst, 1.0 / args.login_every)        # password checks: 0x16, 0x64
        self.accounts = Allowance(args.account_burst, 1.0 / args.account_every)  # accounts created: 0x06
        self.requests = Allowance(args.request_burst, args.request_rate)         # the request budget
        self.arrivals = Allowance(args.new_sessions, args.new_sessions / 60.0)   # new sessions
        self.said = {}

    def rested(self):
        """Nothing is open and every allowance is full again: forgetting it changes nothing."""
        return self.sessions == 0 and self.logins.full() and self.accounts.full() and self.requests.full() and self.arrivals.full()


def address_key(text):
    """What the limits of a player address are kept under: an IPv4 address itself; of an
    IPv6 address its /64, since one subscriber has a whole one to pick addresses from."""
    try:
        ip = ipaddress.ip_address(text.split("%")[0])
    except ValueError:
        return text
    if ip.version == 6:
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        return str(ipaddress.IPv6Network((int(ip) >> 64 << 64, 64)))
    return str(ip)


def player_address(peer, real_ip_lines, trust_proxy):
    """The player's address for a connection from 'peer' that carried these X-Real-IP lines.

    Without --trust-proxy, and for a connection that does not come from this host, it is
    the peer and no header is looked at: whoever connects could write anything there.
    From this host with --trust-proxy it is what the web server in front says it saw: the
    last value of the line. A web server that sets the header (nginx's proxy_set_header)
    replaces what the client sent; one that appends to it puts its own value last.
    MORE THAN ONE LINE is nothing a web server sends: one of them is the client's own,
    and which comes first is the web server's habit (nginx writes its own headers before
    those it passes on) - the answer is None, and the connection is turned away. No line,
    or a line that holds no address, leaves the peer: every such connection then shares
    this host's own allowances, which is the careful side."""
    try:
        local = ipaddress.ip_address(peer).is_loopback
    except ValueError:
        local = False
    if not trust_proxy or not local or not real_ip_lines:
        return peer
    if len(real_ip_lines) > 1:
        return None
    try:
        return str(ipaddress.ip_address(real_ip_lines[0].split(",")[-1].strip()))
    except ValueError:
        return peer


def say(said, kind, text, every=60.0):
    """A log line of a kind that could be made to repeat without end: one every so often,
    and how many were left out is said with the next."""
    now = time.monotonic()
    last = said.get(kind)
    if last and now - last[0] < every:
        last[1] += 1
        return
    if not last and len(said) >= 32:
        return
    said[kind] = [now, 0]
    log(text + ("; %d more of the kind since it was last said" % last[1] if last and last[1] else ""))


def one_piece(transport, owner, resumed):
    """Makes a connection take one piece at a time: 'owner.busy' is set while it has not
    sent all it was given, and 'resumed' is called when it has.

    What follows meanwhile is kept by the owner in ONE buffer. Left to itself the event
    loop's transport keeps every write as a piece of its own and adds up their lengths at
    every further write (Python 3.12), so a connection that does not take its data would
    cost more with every small message sent to it - and with it everybody else's game."""
    protocol = transport.get_protocol()
    pause, resume = protocol.pause_writing, protocol.resume_writing

    def paused():
        owner.busy = True
        pause()

    def free():
        resume()
        owner.busy = False
        resumed()

    protocol.pause_writing, protocol.resume_writing = paused, free
    transport.set_write_buffer_limits(high=0)


def frame(opcode, payload):
    n = len(payload)
    if n < 126:
        head = bytes((0x80 | opcode, n))
    elif n < 65536:
        head = bytes((0x80 | opcode, 126)) + struct.pack(">H", n)
    else:
        head = bytes((0x80 | opcode, 127)) + struct.pack(">Q", n)
    return head + payload


async def read_frame(reader, largest):
    """One frame from a browser: (opcode, payload). Browsers mask what they send."""
    head = await reader.readexactly(2)
    opcode, n = head[0] & 0x0F, head[1] & 0x7F
    if head[0] & 0x70 or not head[0] & 0x80 or not head[1] & 0x80:
        raise Stop(N_PROTOCOL, "a WebSocket frame this relay does not take (extension bits, fragment, or not masked)")
    if n == 126:
        n = struct.unpack(">H", await reader.readexactly(2))[0]
    elif n == 127:
        n = struct.unpack(">Q", await reader.readexactly(8))[0]
    if n > largest:
        raise Stop(N_PROTOCOL, "a message of %d bytes (the largest taken is %d)" % (n, largest))
    key = await reader.readexactly(4)
    data = await reader.readexactly(n)
    if n:
        mask = (key * (n // 4 + 1))[:n]
        data = (int.from_bytes(data, "big") ^ int.from_bytes(mask, "big")).to_bytes(n, "big")
    return opcode, data


class LobbyReader:
    """Reads what the lobby server sends on one connection, for the addresses it names.

    Nothing is changed and nothing is held back: the bytes have gone to the page already.
    A lobby message is a length of four bytes (big-endian, counting itself) and a payload
    whose numbers are little-endian: u16 kind, u32 tracking number (0 in a notification),
    in a reply a u32 result, then the body (docs/lobby-protocol.md, sections 2, 3, 8.5
    and 9.4). Three messages carry another player's address; each carries two, the
    "own-network" pair the player claimed and the pair the server observed. Only the
    observed pair is taken."""

    def __init__(self):
        self.buffer = b""
        self.skip = 0  # bytes of a message too large to be one of the three

    def feed(self, data):
        """Yields (address, port) for every observed pair in the messages completed by 'data'."""
        if self.skip:
            gone = min(self.skip, len(data))
            self.skip -= gone
            data = data[gone:]
        self.buffer += data
        found = []
        while len(self.buffer) >= 4:
            length = struct.unpack(">I", self.buffer[:4])[0]
            if length < 4:  # not a lobby message: nothing further on this connection is read
                self.buffer, self.skip = b"", 1 << 62
                break
            if length > LOBBY_FRAME:  # too large to be one of the three: it passes unread
                if len(self.buffer) >= length:
                    self.buffer = self.buffer[length:]
                    continue
                self.skip = length - len(self.buffer)
                self.buffer = b""
                break
            if len(self.buffer) < length:
                break
            payload, self.buffer = self.buffer[4:length], self.buffer[length:]
            try:
                found.extend(self.pairs(payload))
            except (struct.error, IndexError, ValueError, UnicodeError):
                pass  # not the layout expected: no address from this message
        return found

    @staticmethod
    def pairs(payload):
        if len(payload) < 6:
            return []
        kind = struct.unpack_from("<H", payload, 0)[0]
        if kind not in (0x55, 0x57, 0x65):
            return []
        at = [6]

        def u32():
            value = struct.unpack_from("<I", payload, at[0])[0]
            at[0] += 4
            return value

        def text(wide):
            count = u32()
            size = count * 2 if wide else count
            if count > 512 or at[0] + size > len(payload):
                raise ValueError("a string longer than its message")
            raw = payload[at[0]:at[0] + size]
            at[0] += size
            return raw.decode("utf-16-le" if wide else "ascii")

        def blob():
            size = u32()
            if at[0] + size > len(payload):
                raise ValueError("a blob longer than its message")
            at[0] += size

        def many(read):
            count = u32()
            if count > 256:
                raise ValueError("more entries than a list has")
            return [read() for _ in range(count)]

        def pair(address, port):
            if not 0 < port < 65536:
                raise ValueError("not a port")
            return ip_int(address.strip("\0 ")), port

        if kind == 0x65:  # notification: a player wants into this player's game
            text(False), u32()
            return [pair(text(False), u32())]
        if u32() != 0:  # a reply that says "failed" names nobody
            return []
        if kind == 0x57:  # reply: the game found by its name
            text(True), u32(), text(True), u32()
            return [pair(text(True), u32())]
        # 0x55, reply: the list of games - eight arrays, the hosts' observed addresses and ports last
        many(lambda: text(True)), many(lambda: text(True)), many(u32), many(blob), many(lambda: text(True)), many(u32)
        addresses, ports = many(lambda: text(True)), many(u32)
        found = []
        for address, port in zip(addresses, ports):
            try:
                found.append(pair(address, port))
            except ValueError:
                pass
        return found


class Tcp:
    def __init__(self):
        self.writer = None
        self.task = None
        self.shut = False
        self.lobby = LobbyReader()
        self.held = bytearray()  # what the page has sent and the lobby server has not been handed yet
        self.busy = False        # the connection has not sent all it was given (one_piece)
        self.timer = None        # set while requests wait for the address's budget
        self.waited = False
        self.ended = False       # the lobby server has closed its side


class Udp:
    def __init__(self, sock, port):
        self.sock = sock
        self.port = port


class Path:
    """An outside address and port a session's datagrams pass to and from."""

    def __init__(self, real, rate, why):
        self.real = real      # where to send: (text, port) - the loop-back address for a program on this host
        self.heard = time.monotonic()
        self.rate = Bucket(rate)
        self.why = why
        self.out = self.back = 0


class Session:
    def __init__(self, relay, reader, writer, address, number, where=None):
        self.relay, self.reader, self.writer = relay, reader, writer
        self.address, self.number = address, number
        self.where = where  # the player address's allowances (Address); None only for a session that is not taken
        self.tcp, self.udp = {}, {}
        self.greeted = False
        self.closed = False
        self.stuck = False
        self.busy = False       # the connection to the page has not sent all it was given (one_piece)
        self.out = bytearray()  # what waits for the page meanwhile
        one_piece(writer.transport, self, self.flush)
        self.last_use = time.monotonic()
        self.messages = Bucket(relay.args.message_rate)
        self.bytes = Bucket(relay.args.byte_rate)
        self.connects = Bucket(relay.args.connect_rate)
        self.discovery = Bucket(DISCOVERY_RATE)
        self.counts = {"tcp": 0, "tcp_out": 0, "tcp_in": 0, "udp_lobby": 0, "udp_peer": 0, "udp_in": 0, "udp_dropped": 0, "refused": 0,
                       "out": 0, "back": 0, "not_open": 0, "strangers": 0, "paths": 0, "requests": 0, "held": 0, "limited": 0}
        self.noticed = set()
        self.told = {}    # notices of a kind that could repeat: when each was last sent
        # players outside: (address, port) -> ...
        self.named = {}   # ... when the lobby server last named it
        self.asked = {}   # ... when the page last asked to send there, not open
        self.heard = {}   # ... when a datagram last came from there, not open
        self.paths = {}   # ... the open Path
        self.arrivals = Bucket(relay.args.message_rate)  # datagrams from outside, per second
        self.arrival_bytes = Bucket(relay.args.byte_rate)

    # ---- to the page
    def send(self, kind, payload=b""):
        if self.closed:
            return False
        try:
            self.raw(frame(2, bytes((kind,)) + payload))
        except (ConnectionError, RuntimeError, OSError):
            return False
        return True

    def raw(self, data):
        """Bytes for the page: to the connection when it is free, else to what waits for it.
        A page that lets too much wait is not kept: it is this program's memory."""
        if not self.busy:
            self.writer.write(data)
            return
        self.out += data
        if len(self.out) > PAGE_HIGH and not self.stuck:
            self.stuck = True
            asyncio.get_running_loop().call_soon(self.close, "the page does not read what it is sent (%d bytes were waiting)" % len(self.out))

    def flush(self):
        """The connection has sent what it had: it is given all that has waited, as one piece."""
        if self.out and not self.closed:
            data = bytes(self.out)
            del self.out[:]
            try:
                self.writer.write(data)
            except (ConnectionError, RuntimeError, OSError):
                pass

    def notice(self, code, text):
        self.send(NOTICE, bytes((code,)) + text.encode("utf-8")[:300])

    def tell(self, kind, code, text, every=10.0):
        """A notice of a kind that a page could earn again and again: one every so often."""
        now = time.monotonic()
        if now - self.told.get(kind, -1e9) < every or (kind not in self.told and len(self.told) >= 16):
            return
        self.told[kind] = now
        self.notice(code, text)

    def waiting(self):
        """Bytes that wait for the page behind what its connection is sending."""
        return len(self.out)

    # ---- the session
    async def run(self):
        relay = self.relay
        why = "the page closed the connection"
        try:
            while True:
                try:
                    opcode, data = await asyncio.wait_for(read_frame(self.reader, relay.args.max_message), relay.args.silent)
                except asyncio.TimeoutError:
                    raise Stop(N_IDLE, "nothing heard from the page for %d seconds" % relay.args.silent)
                if opcode == 8:
                    break
                if opcode == 9:
                    # a WebSocket ping is answered, and counts as a message like any other
                    if not self.messages.take() or not self.bytes.take(len(data)):
                        raise Stop(N_TOO_MUCH, "more data than a game sends")
                    self.raw(frame(10, data[:125]))
                    continue
                if opcode == 10:
                    continue
                if opcode != 2 or not data:
                    raise Stop(N_PROTOCOL, "not a binary message")
                self.message(data[0], data[1:])
        except Stop as stop:
            why = str(stop)
            self.notice(stop.code, why)
        except asyncio.IncompleteReadError:
            why = "the connection to the page ended without a goodbye"
        except (ConnectionError, OSError) as error:
            why = "the connection to the page was lost (%s)" % (type(error).__name__ + (": " + str(error) if str(error) else ""))
        except (struct.error, IndexError):
            why = "a message too short for its kind"
            self.notice(N_PROTOCOL, why)
        finally:
            self.close(why)

    def close(self, why):
        if self.closed:
            return
        for conn in self.tcp.values():
            self.tcp_drop(conn)
        self.tcp.clear()
        for sock_id in list(self.udp):
            self.udp_close(sock_id)
        self.goodbye(1000)
        self.closed = True
        self.relay.gone(self)
        c = self.counts
        log("session %d (%s) ended: %s; %d TCP connection(s), %d bytes to the lobby, %d from it; datagrams: %d to the lobby, %d to players, %d from players, %d dropped, %d refused; "
            "players outside: %d path(s), %d datagrams out, %d back, %d not sent (no path), %d not passed on (no path); "
            "lobby requests: %d passed on, %d made to wait, %d refused (the address's limits)"
            % (self.number, self.address, why, c["tcp"], c["tcp_out"], c["tcp_in"], c["udp_lobby"], c["udp_peer"], c["udp_in"], c["udp_dropped"], c["refused"],
               c["paths"], c["out"], c["back"], c["not_open"], c["strangers"], c["requests"], c["held"], c["limited"]))

    def goodbye(self, code):
        """The connection to the page is closed. What still waits for it is sent first, if
        the page takes it within a few seconds; nothing is kept for a page that does not read."""
        transport = self.writer.transport
        try:
            if self.stuck:
                transport.abort()
            else:
                self.writer.write(bytes(self.out) + frame(8, struct.pack(">H", code)))
                self.writer.close()
                asyncio.get_running_loop().call_later(LINGER, transport.abort)
        except (ConnectionError, RuntimeError, OSError):
            pass
        del self.out[:]

    def idle(self):
        """Nothing open towards the lobby and nothing sent for the idle time. A connection
        the lobby server has closed, and the page has not, is not open."""
        return all(conn.ended for conn in self.tcp.values()) and time.monotonic() - self.last_use > self.relay.args.idle

    def message(self, kind, body):
        relay = self.relay
        if not self.greeted:
            if kind != HELLO or len(body) < 1 or body[0] != VERSION:
                raise Stop(N_PROTOCOL, "the page speaks another version of the relay's messages")
            self.greeted = True
            self.send(WELCOME, struct.pack(">BIIHH", VERSION, relay.lobby_int, relay.own_int, min(relay.args.idle, 65535), relay.args.max_message))
            return
        if not self.messages.take() or not self.bytes.take(len(body)):
            if kind == UDP_SEND:
                self.counts["udp_dropped"] += 1  # a datagram too many is lost, as on any line
                return
            raise Stop(N_TOO_MUCH, "more data than a game sends")
        if kind == PING:  # counted as a message, but it is not use: an idle session stays idle
            self.send(PONG, body[:16])
            return
        self.last_use = time.monotonic()
        if kind == UDP_SEND:
            sock_id, address, port = struct.unpack(">BIH", body[:7])
            self.udp_send(sock_id, address, port, body[7:])
        elif kind == TCP_DATA:
            conn_id = struct.unpack(">H", body[:2])[0]
            conn = self.tcp.get(conn_id)
            if conn and not conn.shut and not conn.ended:
                self.tcp_data(conn_id, conn, body[2:])
        elif kind == TCP_OPEN:
            conn_id, address, port = struct.unpack(">HIH", body[:8])
            self.tcp_open(conn_id, address, port)
        elif kind == TCP_SHUT:
            conn_id = struct.unpack(">H", body[:2])[0]
            conn = self.tcp.get(conn_id)
            if conn and not conn.shut:
                conn.shut = True  # said to the lobby server when the requests that wait here have gone (pump)
                self.pump(conn_id, conn)
        elif kind == TCP_CLOSE:
            conn = self.tcp.pop(struct.unpack(">H", body[:2])[0], None)
            if conn:
                self.tcp_drop(conn)
        elif kind == UDP_OPEN:
            known = body[0] in self.udp
            entry = self.udp_get(body[0])
            if known:  # asked again: told again
                self.send(UDP_BOUND, struct.pack(">BH", body[0], entry.port))
        elif kind == UDP_CLOSE:
            self.udp_close(body[0])
        else:
            raise Stop(N_PROTOCOL, "a message of a kind this relay does not know (%d)" % kind)

    def refuse(self, what):
        self.counts["refused"] += 1
        if what not in self.noticed and len(self.noticed) < 8:
            self.noticed.add(what)
            self.notice(N_NOT_ALLOWED, what)
            log("session %d (%s): refused: %s" % (self.number, self.address, what))

    # ---- TCP: to the lobby server only
    def tcp_open(self, conn_id, address, port):
        relay = self.relay
        if conn_id in self.tcp:
            raise Stop(N_PROTOCOL, "a TCP connection number used twice")
        if address != relay.lobby_int or port not in relay.tcp_ports:
            self.refuse("a TCP connection to %s:%d (only the lobby server's own ports are reached)" % (ip_text(address), port))
            self.send(TCP_OPENED, struct.pack(">HB", conn_id, NOT_ALLOWED))
            return
        if len(self.tcp) >= MAX_TCP or not self.connects.take():
            # too many at a time, or faster than a game that cannot get through tries again
            self.send(TCP_OPENED, struct.pack(">HB", conn_id, TOO_MANY))
            return
        conn = self.tcp[conn_id] = Tcp()
        conn.task = asyncio.ensure_future(self.tcp_run(conn_id, conn, port))

    def tcp_data(self, conn_id, conn, data):
        """What the page sends on a connection to the lobby server: kept until a request is whole."""
        conn.held += data
        if len(conn.held) > REQUESTS_HELD:
            self.tcp_end(conn_id, conn, "held", N_TOO_MUCH, "more requests are waiting on one connection than the lobby server would be sent")
            return
        self.pump(conn_id, conn)

    def pump(self, conn_id, conn):
        """Hands the lobby server the whole requests that wait on a connection, as far as
        the player's address may send them (the module's text, "Limits per player address")."""
        if self.closed or self.tcp.get(conn_id) is not conn or conn.writer is None or conn.busy:
            return  # (a connection that has not sent what it was given is given no more: pump is called again when it has)
        if conn.timer:
            conn.timer.cancel()
            conn.timer = None
        where, args, held = self.where, self.relay.args, conn.held
        while len(held) >= 4:
            length = int.from_bytes(held[:4], "big")
            if length < 4 or length > LOBBY_REQUEST:
                # the lobby server closes a connection that sends this; it is not sent
                self.tcp_end(conn_id, conn, "form", N_PROTOCOL, "what the page sent to the lobby server is not a lobby request (a length of %d)" % length)
                return
            if len(held) < length:
                break
            kind = held[4] | held[5] << 8 if length >= 6 else 0
            if not where.requests.has(1.0):
                # as at the lobby server: nothing is refused, the requests wait
                if not conn.waited:
                    conn.waited = True
                    self.counts["held"] += 1
                self.tell("budget", N_LIMIT, "your address sends the lobby server more requests than it takes from one address "
                          "(%g a second, %g at once): they wait" % (args.request_rate, args.request_burst), 30.0)
                conn.timer = asyncio.get_running_loop().call_later(where.requests.wait(1.0) + 0.01, self.pump, conn_id, conn)
                return
            if kind in PASSWORD_CHECKS:
                if not where.logins.has(1.0):
                    self.limited(conn_id, conn, "log-ins", where.logins, args.login_burst, args.login_every)
                    return
                where.logins.take(1.0)
            elif kind == CREATE_ACCOUNT:
                if not where.accounts.has(1.0):
                    self.limited(conn_id, conn, "new accounts", where.accounts, args.account_burst, args.account_every)
                    return
                where.accounts.take(1.0)
            where.requests.take(KEEP_ALIVE_COST if length == 4 else REQUEST_COST.get(kind, 1.0))
            conn.waited = False
            try:
                conn.writer.write(bytes(held[:length]))
            except (ConnectionError, RuntimeError, OSError):
                return  # the connection's own task says that it is gone
            del held[:length]
            self.counts["tcp_out"] += length
            self.counts["requests"] += 1
            if conn.busy:
                return
        if conn.shut and conn.writer.can_write_eof() and not conn.writer.transport.is_closing():
            del held[:]  # no more to send: half a request is no request
            try:
                conn.writer.write_eof()
            except (OSError, RuntimeError):
                pass

    def limited(self, conn_id, conn, what, allowance, most, every):
        """A request over the allowance of the player's address: not handed to the lobby server."""
        wait = int(allowance.wait(1.0)) + 1
        self.counts["limited"] += 1
        say(self.where.said, what, "session %d (%s): %s over the address's allowance (%g at once, one more every %g s): not passed to the lobby server"
            % (self.number, self.address, what, most, every))
        self.tcp_end(conn_id, conn, what, N_LIMIT, "too many %s from your address: the relay passes %g at once and then one more every %g seconds. "
                     "Wait %d seconds and try again" % (what, most, every, wait))

    def tcp_end(self, conn_id, conn, kind, code, text):
        """A connection to the lobby server is closed from here, and the page is told why."""
        self.tell(kind, code, text)
        if self.tcp.get(conn_id) is conn:
            del self.tcp[conn_id]
        self.tcp_drop(conn)
        self.send(TCP_CLOSED, struct.pack(">H", conn_id))

    async def tcp_run(self, conn_id, conn, port):
        relay = self.relay
        status = OK
        try:
            reader, writer = await asyncio.wait_for(asyncio.open_connection(relay.lobby_text, port), relay.args.connect_timeout)
        except asyncio.TimeoutError:
            status = TIMED_OUT
        except ConnectionRefusedError:
            status = REFUSED
        except OSError:
            status = UNREACHABLE
        if status != OK:
            if self.tcp.get(conn_id) is conn:
                del self.tcp[conn_id]
            self.send(TCP_OPENED, struct.pack(">HB", conn_id, status))
            return
        conn.writer = writer
        one_piece(writer.transport, conn, lambda: self.pump(conn_id, conn))
        sock = writer.get_extra_info("socket")
        if sock is not None:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.counts["tcp"] += 1
        self.send(TCP_OPENED, struct.pack(">HB", conn_id, OK))
        head = struct.pack(">H", conn_id)
        self.pump(conn_id, conn)  # what the page sent while the connection was being made
        try:
            while True:
                data = await reader.read(4096)
                if not data:
                    conn.ended = True
                    self.send(TCP_EOF, head)
                    return  # the page closes it when the console has
                self.counts["tcp_in"] += len(data)
                self.last_use = time.monotonic()
                self.send(R_TCP_DATA, head + data)
                for address, port in conn.lobby.feed(data):
                    self.name(address, port)
                await self.writer.drain()
        except (ConnectionError, OSError):
            if self.tcp.get(conn_id) is conn:
                del self.tcp[conn_id]
                self.tcp_drop(conn, cancel=False)
                self.send(TCP_CLOSED, head)

    def tcp_drop(self, conn, cancel=True):
        if conn.timer:
            conn.timer.cancel()
            conn.timer = None
        if cancel and conn.task and not conn.task.done():
            conn.task.cancel()
        if conn.writer:
            try:
                conn.writer.close()
            except (OSError, RuntimeError):
                pass

    # ---- UDP: one socket here per socket of the console's network
    def udp_get(self, sock_id):
        entry = self.udp.get(sock_id)
        if entry:
            return entry
        if sock_id >= MAX_UDP or len(self.udp) >= MAX_UDP:
            raise Stop(N_PROTOCOL, "more UDP sockets than a game uses")
        sock = self.relay.udp_socket()
        if sock is None:
            raise Stop(N_FULL, "the relay has no UDP port left; try again later")
        entry = self.udp[sock_id] = Udp(sock, sock.getsockname()[1])
        self.relay.ports[entry.port] = (self, sock_id)
        if not self.relay.args.pages_only:
            asyncio.get_running_loop().add_reader(sock.fileno(), self.udp_arrived, sock_id, entry)
        self.send(UDP_BOUND, struct.pack(">BH", sock_id, entry.port))
        return entry

    def udp_close(self, sock_id):
        entry = self.udp.pop(sock_id, None)
        if entry:
            self.relay.ports.pop(entry.port, None)
            if not self.relay.args.pages_only:
                asyncio.get_running_loop().remove_reader(entry.sock.fileno())
            entry.sock.close()
            # whoever gets this port next is another player: nobody keeps a path to it
            key = (self.relay.own_int, entry.port)
            for other in self.relay.sessions:
                if other is not self:
                    for table in (other.named, other.asked, other.heard):
                        table.pop(key, None)
                    other.shut(key, "that page has closed its socket")

    def udp_send(self, sock_id, address, port, data):
        relay = self.relay
        entry = self.udp_get(sock_id)
        if address == relay.lobby_int and port == relay.args.udp_port:
            # the discovery datagram: the lobby server learns this socket's address from it
            if len(data) > DISCOVERY_SIZE or not self.discovery.take():
                self.counts["udp_dropped"] += 1
                return
            try:
                entry.sock.sendto(data, (relay.lobby_text, port))
                self.counts["udp_lobby"] += 1
            except OSError:
                self.counts["udp_dropped"] += 1
            return
        if len(data) > MAX_DATAGRAM:
            self.counts["udp_dropped"] += 1  # larger than anything the game sends a player
            return
        target = relay.ports.get(port) if address == relay.own_int else None
        if target is not None:
            # another player of this relay: handed over inside, when that page wants to hear from this one
            other, other_sock = target
            key, now = (address, port), time.monotonic()
            if key not in self.paths and now - self.named.get(key, -1e9) >= NAMED_FOR:
                self.remember(self.asked, key, MAX_ASKED)  # this page wants to hear from that one from now on
            path = other.wanted((relay.own_int, entry.port)) if other is not self else None
            if path is None:
                self.counts["not_open"] += 1
                other.counts["strangers"] += 1
                return
            path.heard = now
            if other.waiting() > WRITE_HIGH:
                self.counts["udp_dropped"] += 1
                return
            path.back += 1
            self.counts["udp_peer"] += 1
            other.counts["udp_in"] += 1
            other.send(UDP_RECV, struct.pack(">BIH", other_sock, relay.own_int, entry.port) + data)
            return
        if relay.args.pages_only:
            if address == relay.own_int:
                self.counts["udp_dropped"] += 1  # nobody: a port that is not open loses the datagram
            else:
                self.refuse("a datagram to %s:%d (only the lobby server and players of this relay are reached)" % (ip_text(address), port))
            return
        # a player outside: only where a path is open
        if port == 0 or (address != relay.own_int and address_kind(address) == NEVER):
            self.refuse("a datagram to %s:%d (not an address a player can have)" % (ip_text(address), port))
            return
        if not relay.outside(address):
            # another player's own-network address, which the game tries as well as the one
            # the server saw; or a port of this host that is no session's. Lost, as between two houses.
            self.counts["not_open"] += 1
            return
        key = (address, port)
        path = self.paths.get(key)
        if path is None:
            now = time.monotonic()
            if now - self.named.get(key, -1e9) < NAMED_FOR:
                path = self.open(key, "the lobby server named it")
            elif now - self.heard.get(key, -1e9) < MEET_WITHIN:
                path = self.open(key, "each has sent to the other")
            if path is None:
                self.remember(self.asked, key, MAX_ASKED)
                self.counts["not_open"] += 1
                return
        if not path.rate.take():
            self.counts["udp_dropped"] += 1
            return
        try:
            entry.sock.sendto(data, path.real)
            path.out += 1
            self.counts["out"] += 1
        except OSError:
            self.counts["udp_dropped"] += 1

    # ---- players outside
    @staticmethod
    def remember(table, key, most):
        table.pop(key, None)
        if len(table) >= most:
            del table[next(iter(table))]  # the oldest goes
        table[key] = time.monotonic()

    def name(self, address, port):
        """The lobby server named this address to the page (LobbyReader)."""
        relay = self.relay
        if address == relay.own_int and port in relay.ports:
            # a player of this relay: handed over inside, and this page now wants to hear from it
            if relay.ports[port][0] is not self:
                self.remember(self.named, (address, port), MAX_NAMED)
            return
        if relay.args.pages_only or not relay.outside(address):
            return
        self.remember(self.named, (address, port), MAX_NAMED)

    def wanted(self, key):
        """A datagram from another page of this relay, which this page knows as 'key': the
        path it takes here, or None. This page wants to hear from that one when the lobby
        server named it to this page, or when this page has itself sent to it within the
        last half minute - so no page can make another page receive anything alone."""
        path = self.paths.get(key)
        if path is None:
            now = time.monotonic()
            if now - self.named.get(key, -1e9) < NAMED_FOR:
                path = self.open(key, "another page of this relay; the lobby server named it")
            elif now - self.asked.get(key, -1e9) < MEET_WITHIN:
                path = self.open(key, "another page of this relay; each has sent to the other")
        return path

    def open(self, key, why, real=None):
        if len(self.paths) >= MAX_PATHS:
            now = time.monotonic()
            oldest = min(self.paths, key=lambda k: self.paths[k].heard)
            if now - self.paths[oldest].heard < MEET_WITHIN:
                return None  # all in use
            self.shut(oldest, "the session has as many paths as it may")
        address, port = key
        if real is None:
            real = (ip_text(address), port)
        path = self.paths[key] = Path(real, self.relay.args.peer_rate, why)
        self.asked.pop(key, None)
        self.heard.pop(key, None)
        self.counts["paths"] += 1
        if self.counts["paths"] <= 64:
            log("session %d (%s): path to the player at %s:%d opened (%s)" % (self.number, self.address, ip_text(address), port, why))
        return path

    def shut(self, key, why):
        path = self.paths.pop(key, None)
        if path and self.counts["paths"] <= 64:
            log("session %d (%s): path to the player at %s:%d closed (%s); %d datagrams out, %d back" % (self.number, self.address, ip_text(key[0]), key[1], why, path.out, path.back))

    def tidy(self):
        """Paths that hear nothing are closed; what was asked or heard and never met is forgotten."""
        now = time.monotonic()
        for key in [key for key, path in self.paths.items() if now - path.heard > PATH_SILENT]:
            self.shut(key, "nothing heard from it for %d seconds" % PATH_SILENT)
        for table, age in ((self.asked, MEET_WITHIN), (self.heard, MEET_WITHIN), (self.named, NAMED_FOR)):
            for key in [key for key, at in table.items() if now - at > age]:
                del table[key]

    def udp_arrived(self, sock_id, entry):
        """Datagrams from outside on one of the session's sockets."""
        relay = self.relay
        for _ in range(32):
            try:
                data, source = entry.sock.recvfrom(MAX_DATAGRAM + 1)
            except (BlockingIOError, InterruptedError):
                return
            except OSError:
                return  # an error some earlier datagram earned (a closed port at the other end): nothing to read
            try:
                real, port = ip_int(source[0]), source[1]
            except ValueError:
                continue
            address = real
            if real >> 24 == 127:
                # a program on this host that sent through the loop-back interface is the one
                # the lobby server saw at this host's own address
                address = relay.own_int
            if len(data) > MAX_DATAGRAM or not relay.outside(address) or (address == relay.own_int and port in relay.ports):
                self.counts["strangers"] += 1
                continue
            if (address, port) == (relay.lobby_int, relay.args.udp_port):
                continue  # the lobby server sends no datagrams
            key = (address, port)
            path = self.paths.get(key)
            if path is None:
                now = time.monotonic()
                why = None
                asked = any(a == address and now - at < MEET_WITHIN for (a, _), at in self.asked.items())
                if now - self.named.get(key, -1e9) < NAMED_FOR:
                    why = "the lobby server named it"
                elif any(a == address and now - at < NAMED_FOR for (a, _), at in self.named.items()):
                    why = "the lobby server named its address, with another port" + ("; and each has sent to the other" if asked else "")
                elif asked:
                    why = "each has sent to the other"
                if why:
                    path = self.open(key, why, source[:2])
                if path is None:
                    self.remember(self.heard, key, MAX_HEARD)
                    self.counts["strangers"] += 1
                    continue
            path.real = source[:2]
            path.heard = time.monotonic()
            if not self.arrivals.take() or not self.arrival_bytes.take(len(data)) or self.waiting() > WRITE_HIGH:
                self.counts["udp_dropped"] += 1
                continue
            path.back += 1
            self.counts["back"] += 1
            self.send(UDP_RECV, struct.pack(">BIH", sock_id, address, port) + data)


class Relay:
    def __init__(self, args):
        self.args = args
        info = socket.getaddrinfo(args.lobby, None, socket.AF_INET, socket.SOCK_STREAM)
        self.lobby_text = info[0][4][0]
        self.lobby_int = ip_int(self.lobby_text)
        if ipaddress.IPv4Address(self.lobby_text).is_loopback and not args.test_loopback:
            sys.exit("relay.py: --lobby is a loop-back address. The lobby server would then see every player at 127.0.0.1 "
                     "and tell the others to look for them there. Give this computer's network address instead.")
        if args.own_address:
            own = args.own_address
        else:
            # the address this host has towards the lobby server: what the server will see
            probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            probe.connect((self.lobby_text, args.udp_port))
            own = probe.getsockname()[0]
            probe.close()
        self.own_text, self.own_int = own, ip_int(own)
        self.tcp_ports = set()
        for part in args.tcp_ports.split(","):
            low, _, high = part.partition("-")
            self.tcp_ports.update(range(int(low), int(high or low) + 1))
        self.sessions = set()
        self.ports = {}  # UDP port here -> (session, its socket number)
        self.count = 0
        self.udp_range = None
        if args.udp_ports:
            low, _, high = args.udp_ports.partition("-")
            self.udp_range = (int(low), int(high or low))
            if not 1024 <= self.udp_range[0] <= self.udp_range[1] <= 65535:
                sys.exit("relay.py: --udp-ports wants LOW-HIGH between 1024 and 65535")
        self.udp_next = 0
        for name in ("login_burst", "login_every", "account_burst", "account_every", "request_rate", "request_burst", "new_sessions", "connect_rate", "per_address", "max_sessions"):
            if not getattr(args, name) > 0:
                sys.exit("relay.py: --%s wants a number above 0 (a limit cannot be switched off; give a large number for a test)" % name.replace("_", "-"))
        self.addresses = {}  # player address (address_key) -> Address: what its limits are kept in
        self.said = {}
        self.shaking = 0     # connections that have not finished their handshake
        # a session can hold 1 + MAX_TCP + MAX_UDP descriptors
        self.descriptors = args.max_sessions * (1 + MAX_TCP + MAX_UDP) + MAX_HANDSHAKES + 32
        try:
            import resource
            soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
            if soft != resource.RLIM_INFINITY and soft < self.descriptors:
                resource.setrlimit(resource.RLIMIT_NOFILE, (self.descriptors if hard == resource.RLIM_INFINITY else min(self.descriptors, hard), hard))
        except (ImportError, ValueError, OSError):
            pass

    def place(self, key):
        """The allowances of a player address; None when no more addresses can be kept."""
        where = self.addresses.get(key)
        if where is None:
            if len(self.addresses) >= MAX_ADDRESSES:
                self.rest()
                if len(self.addresses) >= MAX_ADDRESSES:
                    return None  # never by forgetting one that still owes: that would hand out new allowances
            where = self.addresses[key] = Address(self.args)
        return where

    def rest(self):
        """Addresses with nothing open and every allowance full again are forgotten."""
        for key in [key for key, where in self.addresses.items() if where.rested()]:
            del self.addresses[key]

    def outside(self, address):
        """May a datagram pass to or from this address at all (given a path)?"""
        if address == self.own_int:
            return self.args.lan  # a program on this host: tests on one computer
        kind = address_kind(address)
        return kind == PUBLIC or (kind == PRIVATE and self.args.lan)

    def udp_socket(self):
        """A UDP socket for a session: on every address of this host, in the range given."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setblocking(False)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096 if self.args.pages_only else 262144)
        except OSError:
            pass
        if self.udp_range is None:
            sock.bind(("0.0.0.0", 0))
            return sock
        low, high = self.udp_range
        for _ in range(high - low + 1):
            port = low + self.udp_next % (high - low + 1)
            self.udp_next += 1
            try:
                sock.bind(("0.0.0.0", port))
                return sock
            except OSError:
                continue
        sock.close()
        return None

    def gone(self, session):
        if session in self.sessions:
            self.sessions.discard(session)
            session.where.sessions -= 1

    async def client(self, reader, writer):
        args = self.args
        peer = writer.get_extra_info("peername") or ("?", 0)
        sock = writer.get_extra_info("socket")
        if sock is not None:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

        def answer(status, text):
            body = (text + "\n").encode()
            writer.write(("HTTP/1.1 %s\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % (status, len(body))).encode() + body)
            writer.close()

        if self.shaking >= MAX_HANDSHAKES:
            writer.close()  # connections that say nothing are not collected
            return
        self.shaking += 1
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
            lines = head.decode("latin-1").split("\r\n")
            method, target, _ = lines[0].split(" ", 2)
            headers, real_ip = {}, []
            for line in lines[1:]:
                name, colon, value = line.partition(":")
                if colon:
                    headers[name.strip().lower()] = value.strip()
                    if name.strip().lower() == "x-real-ip":
                        real_ip.append(value)
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError, ValueError, OSError):
            writer.close()
            return
        finally:
            self.shaking -= 1
        if method != "GET" or target.split("?")[0] != args.path:
            answer("404 Not Found", "not here")
            return
        key = headers.get("sec-websocket-key", "")
        if headers.get("upgrade", "").lower() != "websocket" or headers.get("sec-websocket-version") != "13" or not key:
            answer("426 Upgrade Required", "this is the relay of the browser build: a WebSocket connection is wanted")
            return
        if args.origin and headers.get("origin") not in args.origin:
            answer("403 Forbidden", "not from this page")
            return
        address = player_address(peer[0], real_ip, args.trust_proxy)
        if address is None:
            say(self.said, "two player addresses", "relay: NOTE: a connection from this host came with %d X-Real-IP lines and was turned away: the web server in front has to SET that header, "
                "which replaces what a client sent (README.md)" % len(real_ip), 600.0)
            answer("400 Bad Request", "one X-Real-IP line is wanted from the web server in front")
            return
        if args.trust_proxy and address == peer[0] and address in ("127.0.0.1", "::1") and (real_ip[-1].split(",")[-1].strip() if real_ip else "") != address:
            say(self.said, "no player address", "relay: NOTE: a connection from this host came without a player address in X-Real-IP (--trust-proxy): it counts as this host itself. "
                "The web server in front has to set that header (README.md)", 600.0)
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n" % accept).encode())
        self.count += 1
        where = self.place(address_key(address))
        session = Session(self, reader, writer, address, self.count, where)
        full = None
        if where is None:
            full = (N_FULL, "the relay is busy (it keeps count of as many addresses as it can); try again later")
        elif len(self.sessions) >= args.max_sessions:
            full = (N_FULL, "the relay is full (%d players); try again later" % len(self.sessions))
        elif where.sessions >= args.per_address:
            full = (N_ADDRESS_FULL, "there are %d pages online from your address already, which is as many as the relay takes" % args.per_address)
        elif not where.arrivals.has(1.0):
            full = (N_LIMIT, "pages from your address have connected %g times within a minute, which is as often as the relay takes them. Wait %d seconds and try again"
                    % (args.new_sessions, int(where.arrivals.wait(1.0)) + 1))
        if full:
            session.notice(*full)
            say(where.said if where else self.said, "not taken", "session %d (%s) not taken: %s" % (session.number, address, full[1]))
            session.goodbye(1013)
            session.closed = True
            return
        where.arrivals.take(1.0)
        where.sessions += 1
        self.sessions.add(session)
        log("session %d (%s) opened; %d open" % (session.number, address, len(self.sessions)))
        await session.run()

    async def sweep(self):
        while True:
            await asyncio.sleep(15)
            for session in list(self.sessions):
                session.tidy()
                if session.idle():
                    session.notice(N_IDLE, "nothing was sent for %d minutes; the page connects again when the game goes online" % (self.args.idle // 60))
                    session.close("idle")
            self.rest()

    async def main(self):
        args = self.args
        host, _, port = args.listen.rpartition(":")
        server = await asyncio.start_server(self.client, host or "127.0.0.1", int(port), limit=8192)
        log("relay: listening on %s%s; lobby server %s (TCP ports %s, UDP %d); this host is %s to it; at most %d sessions, %d from one address%s"
            % (args.listen, args.path, self.lobby_text, args.tcp_ports, args.udp_port, self.own_text, args.max_sessions, args.per_address,
               ("; pages from " + ", ".join(args.origin)) if args.origin else "; pages from anywhere (no --origin)"))
        log("relay: per player address (%s): %g new sessions a minute; %g log-ins at once and one more every %g s; %g new accounts at once and one more every %g s; "
            "lobby requests %g units a second, %g at once" % ("X-Real-IP from the web server on this host" if args.trust_proxy else "the address a connection comes from",
                                                              args.new_sessions, args.login_burst, args.login_every, args.account_burst, args.account_every, args.request_rate, args.request_burst))
        if self.udp_range and self.udp_range[1] - self.udp_range[0] + 1 < args.max_sessions * MAX_UDP:
            log("relay: NOTE: --udp-ports has %d ports; %d sessions could ask for %d between them (a game takes one, a page that means harm %d): the last to come would find none"
                % (self.udp_range[1] - self.udp_range[0] + 1, args.max_sessions, args.max_sessions * MAX_UDP, MAX_UDP))
        try:
            import resource
            if 0 <= resource.getrlimit(resource.RLIMIT_NOFILE)[0] < self.descriptors:
                log("relay: NOTE: this process may hold %d open files; %d sessions can need %d" % (resource.getrlimit(resource.RLIMIT_NOFILE)[0], args.max_sessions, self.descriptors))
        except (ImportError, ValueError, OSError):
            pass
        if args.pages_only:
            log("relay: --pages-only: no datagram passes to or from a player outside this relay")
        else:
            where = "UDP ports %d-%d" % self.udp_range if self.udp_range else "UDP ports the system picks (give --udp-ports to fix a range for a firewall)"
            log("relay: players outside (the desktop application) are reached on %s, at %s" % (where, "public and private addresses and this host (--lan)" if args.lan else "public addresses only"))
            if address_kind(self.own_int) != PUBLIC and not args.lan:
                log("relay: NOTE: this host is %s to the lobby server, which is not a public address: players outside will be told that address for the pages' players. "
                    "On a private network or on one computer, give --lan" % self.own_text)
        loop = asyncio.get_running_loop()
        stop = loop.create_future()
        for name in ("SIGTERM", "SIGINT"):
            try:
                loop.add_signal_handler(getattr(signal, name), lambda: stop.done() or stop.set_result(None))
            except (NotImplementedError, RuntimeError):
                pass
        sweeper = asyncio.ensure_future(self.sweep())
        await stop
        sweeper.cancel()
        server.close()
        for session in list(self.sessions):
            session.notice(N_STOPPING, "the relay is being stopped")
            session.close("the relay is stopping")
        log("relay: stopped")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--lobby", required=True, help="the lobby server, as an address of four numbers or a name; not a loop-back address")
    parser.add_argument("--listen", default="127.0.0.1:8975", help="address:port to listen on (default 127.0.0.1:8975)")
    parser.add_argument("--path", default="/relay", help="the path a page asks for (default /relay); anything else is 404")
    parser.add_argument("--origin", action="append", default=[], help="a page origin that may use the relay (https://host); may be given several times; none: any")
    parser.add_argument("--trust-proxy", action="store_true", help="take the player's address from X-Real-IP when the connection comes from this host (a web server in front, "
                        "which has to SET that header: nginx's proxy_set_header X-Real-IP $remote_addr). Without it every player behind the web server counts as one address")
    parser.add_argument("--tcp-ports", default="40810,40910", help="the lobby server's TCP ports that may be reached (default 40810,40910: gateway and lobby)")
    parser.add_argument("--udp-port", type=int, default=10101, help="the lobby server's discovery port (default 10101)")
    parser.add_argument("--own-address", help="this host's address as the lobby server sees it (default: found by asking the system)")
    parser.add_argument("--test-loopback", action="store_true", help="for tests of the relay itself: take a loop-back address for --lobby (no game can be played through such a relay)")
    parser.add_argument("--udp-ports", metavar="LOW-HIGH", help="the UDP ports the sessions' sockets take, so that a firewall can be opened for them (default: whatever the system gives)")
    parser.add_argument("--lan", action="store_true", help="players on private addresses and on this computer are reached as well (a relay on a home network, a test on one computer); "
                        "without it only public addresses")
    parser.add_argument("--pages-only", action="store_true", help="browser players with browser players only: nothing passes to or from a player outside this relay")
    parser.add_argument("--peer-rate", type=float, default=150, help="datagrams a second a page may send to one player outside (default 150, twice that for a moment; the game sends a player some 30)")
    parser.add_argument("--max-sessions", type=int, default=64)
    parser.add_argument("--per-address", type=int, default=4, help="sessions from one address at a time (default 4)")
    parser.add_argument("--new-sessions", type=float, default=12, help="new sessions from one address: so many at once and so many more a minute (default 12)")
    parser.add_argument("--login-burst", type=float, default=40, help="log-ins and account-detail requests (password checks) one address may send the lobby server at once (default 40, the lobby server's own)")
    parser.add_argument("--login-every", type=float, default=3, help="... and one more every so many seconds (default 3, the lobby server's own)")
    parser.add_argument("--account-burst", type=float, default=20, help="accounts one address may create at once (default 20, the lobby server's own)")
    parser.add_argument("--account-every", type=float, default=180, help="... and one more every so many seconds (default 180, the lobby server's own)")
    parser.add_argument("--request-rate", type=float, default=50, help="lobby requests of one address: units a second (default 50, the lobby server's requests_per_second)")
    parser.add_argument("--request-burst", type=float, default=400, help="... and units at once (default 400, the lobby server's request_burst)")
    parser.add_argument("--connect-rate", type=float, default=8, help="connections to the lobby server a second from one session (default 8, twice that for a moment; "
                        "a game that cannot get through tries about five times a second)")
    parser.add_argument("--idle", type=int, default=900, help="seconds without use, and without a connection to the lobby, after which a session is closed (default 900)")
    parser.add_argument("--silent", type=int, default=60, help="seconds without any message from the page (it pings) after which the session is closed (default 60)")
    parser.add_argument("--max-message", type=int, default=8192, help="largest message taken, in bytes (default 8192)")
    parser.add_argument("--message-rate", type=float, default=600, help="messages a second from one page (default 600; twice that for a moment)")
    parser.add_argument("--byte-rate", type=float, default=262144, help="bytes a second from one page (default 262144)")
    parser.add_argument("--connect-timeout", type=float, default=10)
    args = parser.parse_args()
    # On Python 3.12 Windows, the relay needs the socket-compatible event loop
    # for its UDP handlers; don't depend on a CI script to patch this at runtime.
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    try:
        asyncio.run(Relay(args).main())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
