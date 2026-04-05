"use client";

interface Props {
  streamUrl: string;
  label?: string;
}

export default function LiveCamera({ streamUrl, label }: Props) {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200">
      {label && (
        <div className="bg-gray-100 px-3 py-1 text-sm font-medium text-gray-600">
          {label}
        </div>
      )}
      {/* MJPEG stream from the Raspberry Pi */}
      <img
        src={streamUrl}
        alt={label ?? "Live camera feed"}
        className="h-auto w-full"
      />
    </div>
  );
}
