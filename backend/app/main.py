"""PharmGuard Backend — FastAPI application."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import alerts, auth, inventory, logs

app = FastAPI(
    title="PharmGuard",
    description="Medical IoT medication dispensing & adherence tracking",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(alerts.router, prefix="/api/alerts", tags=["alerts"])
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(inventory.router, prefix="/api/inventory", tags=["inventory"])
app.include_router(logs.router, prefix="/api/logs", tags=["logs"])


@app.get("/health")
async def health():
    return {"status": "ok"}
