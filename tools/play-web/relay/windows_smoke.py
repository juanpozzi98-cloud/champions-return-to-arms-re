"""Smoke test para Windows. No reemplaza la bateria completa del autor."""
import socket
import struct
import sys

from check import (Client, StandIn, start_relay, lobby_open,
                   passes, request, player_to_player, PING, PONG,
                   TCP_OPEN, TCP_OPENED, UDP_SEND, UDP_BOUND)

lobby = StandIn("127.0.0.1")
relay, url = start_relay(lobby, "127.0.0.1", "--lan", "--pages-only",
                          "--silent", "60", "--max-sessions", "8")
a = None
b = None
try:
    a = Client(url, "http://test.invalid")
    b = Client(url, "http://test.invalid")
    welcome_a = a.hello()
    welcome_b = b.hello()
    own = struct.unpack(">I", socket.inet_aton("127.0.0.1"))[0]
    assert welcome_a["own"] == own and welcome_b["own"] == own
    print("OK: dos conexiones WebSocket y protocolo del Relay", flush=True)

    a.send(PING, b"ping-local")
    assert a.expect(PONG) == b"ping-local"
    print("OK: mensaje WebSocket ping/pong", flush=True)

    assert lobby_open(a, 1, own, lobby.tcp_port) == 0
    assert passes(a, 1, request(0x42, b"prueba lobby windows"))
    a.send(TCP_OPEN, struct.pack(">HIH", 2, own, lobby.tcp_port + 1))
    assert struct.unpack(">HB", a.expect(TCP_OPENED)) == (2, 1)
    print("OK: conexión TCP al lobby y rechazo de un puerto ajeno", flush=True)

    a.send(UDP_SEND, struct.pack(">BIH", 0, own, lobby.udp_port) + b"discovery")
    a.expect(UDP_BOUND)
    payload, _ = lobby.udp.recvfrom(100)
    assert payload == b"discovery"
    print("OK: discovery UDP hacia el lobby simulado", flush=True)

    times, lost, ports = player_to_player(a, b, own, count=10, gap=0.001)
    assert lost == 0 and len(times) == 10
    print("OK: 10 intercambios UDP entre dos jugadores simulados", flush=True)
    assert relay.poll() is None
    print("RESULTADO: smoke test Windows correcto (no valida juego real)", flush=True)
except Exception:
    if relay.poll() is not None:
        print("El proceso Relay termino antes de tiempo", flush=True)
    raise
finally:
    if a:
        a.close()
    if b:
        b.close()
    relay.terminate()
    try:
        output, _ = relay.communicate(timeout=10)
    except Exception:
        relay.kill()
        output, _ = relay.communicate()
    print("Ultimas lineas del Relay:", flush=True)
    print("\n".join(output.splitlines()[-8:]), flush=True)
    lobby.tcp.close()
    lobby.udp.close()
