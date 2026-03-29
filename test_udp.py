#!/usr/bin/env python3
"""Send a test pattern directly to Simulator via UDP, bypassing the browser."""
import socket, struct, time, json, os

cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "matrix_sim_config.json")
with open(cfg_path) as f:
    cfg = json.load(f)

TARGET_PORT = cfg["recv_port"]   # Simulator listens here
HOST        = "127.0.0.1"

print(f"Sending to {HOST}:{TARGET_PORT}")

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

def make_pkt(cmd_type, payload=b"", pkt_idx=0):
    hdr = bytearray(14)
    hdr[0] = 0x75
    struct.pack_into(">H", hdr, 8, cmd_type)
    struct.pack_into(">H", hdr, 10, pkt_idx)
    pkt = bytes(hdr) + payload + b"\x00\x00"
    pkt = bytearray(pkt)
    pkt[-1] = sum(pkt[:-1]) & 0xFF
    return bytes(pkt)

def send_frame(grid):
    """grid: list of 32 rows, each 16 (r,g,b) tuples"""
    buf = bytearray(64 * 24)
    for y in range(32):
        for x in range(16):
            r, g, b = grid[y][x]
            channel = y // 4
            row_in_ch = y % 4
            led_pos = row_in_ch * 16 + (x if row_in_ch % 2 == 0 else 15 - x)
            offset = led_pos * 24 + channel
            buf[offset]      = g
            buf[offset + 8]  = r
            buf[offset + 16] = b
    pkts = [
        make_pkt(0x3344),
        make_pkt(0x8877, bytes(buf[:984]), 1),
        make_pkt(0x8877, bytes(buf[984:]), 2),
        make_pkt(0x5566),
    ]
    for p in pkts:
        sock.sendto(p, (HOST, TARGET_PORT))

# Build a colorful test pattern: red top half, blue bottom half, green middle row
grid = []
for y in range(32):
    row = []
    for x in range(16):
        if y < 8:
            row.append((180, 0, 0))   # red
        elif y < 16:
            row.append((0, 180, 0))   # green
        elif y < 24:
            row.append((0, 0, 180))   # blue
        else:
            row.append((180, 180, 0)) # yellow
    grid.append(row)

print("Sending 30 frames over 3 seconds...")
for i in range(30):
    send_frame(grid)
    time.sleep(0.1)

print("Done. If Simulator lit up, the UDP pipeline works!")
sock.close()
