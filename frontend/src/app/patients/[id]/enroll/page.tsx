"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { enrollFace } from "@/lib/api";

const MAX_RECOMMENDED_BYTES = 10 * 1024 * 1024; // 10 MB — warn-only threshold

export default function EnrollFacePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const pid = Number(id);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  function onPick(f: File | null) {
    setError(null);
    setWarning(null);
    setPreviewReady(false);

    if (!f) {
      setFile(null);
      setPreviewUrl(null);
      return;
    }

    // Hard reject: not an image. The native accept="image/*" is a hint, not
    // a guarantee — drag-drop and "All files" pickers can bypass it.
    if (!f.type.startsWith("image/")) {
      setFile(null);
      setPreviewUrl(null);
      setError(
        `Please select an image file (got ${f.type || "unknown type"}).`,
      );
      return;
    }

    if (f.size > MAX_RECOMMENDED_BYTES) {
      const mb = (f.size / 1024 / 1024).toFixed(1);
      setWarning(`Image is ${mb} MB — upload may be slow.`);
    }

    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
  }

  function onPreviewError() {
    setPreviewReady(false);
    setError("Could not read the selected image — file may be corrupted.");
    setFile(null);
    setPreviewUrl(null);
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
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Back to Patient
      </Link>

      <div className="rounded-2xl border border-sand-200 bg-white p-6">
        <h1 className="font-[family-name:var(--font-display)] text-2xl text-gray-900">
          Enrol Patient Face
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Upload one clear front-facing photo. Single face only. JPG or PNG up
          to ~10&nbsp;MB.
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <input
            type="file"
            accept="image/*"
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-gray-600 file:mr-4 file:rounded-lg file:border file:border-sand-200 file:bg-sand-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-olive-700 hover:file:bg-sand-100"
          />

          {previewUrl && (
            <div className="relative mx-auto h-48 w-48">
              {!previewReady && (
                <div className="absolute inset-0 flex items-center justify-center rounded-2xl border border-dashed border-sand-200 text-xs text-gray-400">
                  Loading preview...
                </div>
              )}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewUrl}
                alt="preview"
                onLoad={() => setPreviewReady(true)}
                onError={onPreviewError}
                className={`mx-auto h-48 w-48 rounded-2xl border border-sand-200 object-cover transition-opacity duration-200 ${
                  previewReady ? "opacity-100" : "opacity-0"
                }`}
              />
            </div>
          )}

          {warning && (
            <p className="rounded-lg bg-status-warning-bg px-3 py-2 text-sm text-status-warning">
              {warning}
            </p>
          )}

          {error && (
            <p className="rounded-lg bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!file || !previewReady || submitting}
            className="w-full rounded-xl bg-olive-600 py-2 text-sm font-semibold text-white transition-opacity hover:bg-olive-700 disabled:opacity-50"
          >
            {submitting ? "Enrolling…" : "Enrol Face"}
          </button>
        </form>
      </div>
    </div>
  );
}
