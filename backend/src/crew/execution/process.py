"""Bounded capture for container processes; output never grows without limit."""
import subprocess
import threading


def run_bounded(argv: list[str], timeout: int, limit: int = 64_000) -> subprocess.CompletedProcess:
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    buffers = [bytearray(), bytearray()]
    overflow = threading.Event()
    def drain(stream, buffer):
        while True:
            chunk = stream.read(4096)
            if not chunk:
                break
            remaining = limit - len(buffer)
            buffer.extend(chunk[:remaining])
            if len(chunk) > remaining:
                overflow.set()
                process.kill()
                break
    readers = [threading.Thread(target=drain, args=(stream, buffer), daemon=True)
               for stream, buffer in zip((process.stdout, process.stderr), buffers, strict=True)]
    for reader in readers:
        reader.start()
    try:
        process.wait(timeout=max(1, min(timeout, 120)))
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        for reader in readers:
            reader.join(timeout=2)
        process.stdout.close()
        process.stderr.close()
    if overflow.is_set():
        raise ValueError("sandbox output exceeded the 64000-byte limit")
    return subprocess.CompletedProcess(argv, process.returncode,
        buffers[0].decode("utf-8", "replace"), buffers[1].decode("utf-8", "replace"))
