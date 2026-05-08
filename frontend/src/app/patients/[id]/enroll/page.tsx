"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { enrollFace } from "@/lib/api";

export default function EnrollFacePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const pid = Number(id);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onPick(f: File | null) {
    setFile(f);
    setPreviewUrl(f ? URL.createObjectURL(f) : null);
    setError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setSubmitting(true);
    setError(null);
    try {
      await enrollFace(pid, file);
      router.push(`/patients/${pid}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <Link
        href={`/patients/${pid}`}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-gray-400 transition-colors hover:text-gray-600"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Back to Patient
      </Link>

      <div className="rounded-2xl border border-sand-200 bg-white p-6">
        <h1 className="font-[family-name:var(--font-display)] text-2xl text-gray-900">
          Enrol Patient Face
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Upload one clear front-facing photo. Single face only.
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <input
            type="file"
            accept="image/*"
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-gray-600 file:mr-4 file:rounded-lg file:border file:border-sand-200 file:bg-sand-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-olive-700 hover:file:bg-sand-100"
          />

          {previewUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt="preview"
              className="mx-auto h-48 w-48 rounded-2xl border border-sand-200 object-cover"
            />
          )}

          {error && (
            <p className="rounded-lg bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!file || submitting}
            className="w-full rounded-xl bg-olive-600 py-2 text-sm font-semibold text-white transition-opacity hover:bg-olive-700 disabled:opacity-50"
          >
            {submitting ? "Enrolling…" : "Enrol Face"}
          </button>
        </form>
      </div>
    </div>
  );
}
