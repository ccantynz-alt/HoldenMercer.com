"""
WebSocket endpoint for raw PCM audio from the Orb renderer.

Receives 16-bit mono PCM at 16 kHz (256ms chunks from ScriptProcessorNode).
Can forward to Deepgram or process locally — currently logs volume and
echoes the raw RMS back to the client as JSON for diagnostics.

ws://localhost:8000/ws/audio
"""

from __future__ import annotations

import logging
import struct

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)
router = APIRouter(tags=["ws"])


@router.websocket("/ws/audio")
async def ws_audio(websocket: WebSocket):
    await websocket.accept()
    client = websocket.client
    logger.info("PCM stream connected: %s", client)

    try:
        while True:
            data = await websocket.receive_bytes()

            # Interpret as signed 16-bit little-endian samples
            n_samples = len(data) // 2
            if n_samples == 0:
                continue

            samples = struct.unpack_from(f"<{n_samples}h", data)

            # RMS volume (0.0 – 1.0 normalised from Int16 range)
            rms = (sum(s ** 2 for s in samples) / n_samples) ** 0.5 / 32768

            # Echo intensity back — the Orb can use this as a server-validated signal
            await websocket.send_json({"rms": round(rms, 4), "samples": n_samples})

            # ── Extension point ────────────────────────────────────────────────
            # Forward to Deepgram:
            #   await deepgram_socket.send(data)
            #
            # Run Whisper on accumulated buffer:
            #   buffer.extend(samples); if len(buffer) >= 16000: transcribe(buffer)
            #
            # Trigger shadow architect on voice command detection:
            #   if rms > SPEECH_THRESHOLD: await handle_voice_frame(data)

    except WebSocketDisconnect:
        logger.info("PCM stream disconnected: %s", client)
    except Exception as exc:
        logger.error("ws_audio error: %s", exc)
        await websocket.close(code=1011)
