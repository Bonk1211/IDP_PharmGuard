"""Database models for PharmGuard."""

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class Patient(Base):
    __tablename__ = "patients"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    face_encoding: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )

    adherence_logs: Mapped[list["AdherenceLog"]] = relationship(back_populates="patient")


class Medication(Base):
    __tablename__ = "medications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    slot: Mapped[int] = mapped_column(Integer)
    quantity: Mapped[int] = mapped_column(Integer, default=0)
    patient_id: Mapped[int | None] = mapped_column(ForeignKey("patients.id"), nullable=True)


class AdherenceLog(Base):
    __tablename__ = "adherence_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"))
    slot: Mapped[int] = mapped_column(Integer)
    pill_taken: Mapped[bool] = mapped_column(Boolean)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )

    patient: Mapped["Patient"] = relationship(back_populates="adherence_logs")
