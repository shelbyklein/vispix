import { useState, useCallback } from "react";
import type { UppyFile } from "@uppy/core";

interface UploadMetadata {
  name: string;
  size: number;
  contentType: string;
}

interface UploadResponse {
  uploadURL: string;
  objectPath: string;
  metadata: UploadMetadata;
}

interface UseUploadOptions {
  /** Base path where object storage routes are mounted (default: "/api/storage") */
  basePath?: string;
  onSuccess?: (response: UploadResponse) => void;
  onError?: (error: Error) => void;
}

// Mirrors the presign route's gate (routes/storage.ts): images plus fonts for
// the asset library (#162). Photos stay image-only via the register route's
// magic-byte check. Some browsers send fonts as octet-stream, so fall back to
// the extension.
export function isAllowedUploadType(name: string, contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith("image/") ||
    ct.startsWith("font/") ||
    /(woff|ttf|otf|sfnt|fontobject|opentype|truetype)/.test(ct) ||
    /\.(ttf|otf|woff2?|eot)$/i.test(name)
  );
}

/**
 * React hook for handling file uploads with presigned URLs.
 *
 * This hook implements the two-step presigned URL upload flow:
 * 1. Request a presigned URL from your backend (sends JSON metadata, NOT the file)
 * 2. Upload the file directly to the presigned URL
 *
 * @example
 * ```tsx
 * function FileUploader() {
 *   const { uploadFile, isUploading, error } = useUpload({
 *     onSuccess: (response) => {
 *       console.log("Uploaded to:", response.objectPath);
 *     },
 *   });
 *
 *   const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
 *     const file = e.target.files?.[0];
 *     if (file) {
 *       await uploadFile(file);
 *     }
 *   };
 *
 *   return (
 *     <div>
 *       <input type="file" onChange={handleFileChange} disabled={isUploading} />
 *       {isUploading && <p>Uploading...</p>}
 *       {error && <p>Error: {error.message}</p>}
 *     </div>
 *   );
 * }
 * ```
 */
export function useUpload(options: UseUploadOptions = {}) {
  const basePath = options.basePath ?? "/api/storage";
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [progress, setProgress] = useState(0);

  const requestUploadUrl = useCallback(
    async (file: File, signal?: AbortSignal): Promise<UploadResponse> => {
      const response = await fetch(`${basePath}/uploads/request-url`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          contentType: file.type || "application/octet-stream",
        }),
        signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to get upload URL");
      }

      return response.json();
    },
    []
  );

  const uploadToPresignedUrl = useCallback(
    (file: File, uploadURL: string, onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<void> => {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", uploadURL);
        xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

        // Stall watchdog: a connection that stops making progress would
        // otherwise hang forever and permanently occupy a bulk-upload slot.
        // A whole-request timeout would kill legitimately slow large uploads,
        // so abort only after no progress events for STALL_MS.
        const STALL_MS = 60_000;
        let stalled = false;
        const onStall = () => {
          stalled = true;
          xhr.abort();
        };
        let stallTimer = setTimeout(onStall, STALL_MS);
        const resetStallTimer = () => {
          clearTimeout(stallTimer);
          stallTimer = setTimeout(onStall, STALL_MS);
        };
        const clearStallTimer = () => clearTimeout(stallTimer);

        if (signal) {
          if (signal.aborted) {
            clearStallTimer();
            reject(new Error("Upload aborted"));
            return;
          }
          signal.addEventListener("abort", () => xhr.abort(), { once: true });
        }

        xhr.upload.addEventListener("progress", (e) => {
          resetStallTimer();
          if (onProgress && e.lengthComputable) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        });

        xhr.addEventListener("load", () => {
          clearStallTimer();
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error("Failed to upload file to storage"));
          }
        });

        xhr.addEventListener("error", () => {
          clearStallTimer();
          reject(new Error("Failed to upload file to storage"));
        });
        xhr.addEventListener("abort", () => {
          clearStallTimer();
          reject(
            new Error(
              stalled
                ? "Upload stalled (no progress for 60s) and was aborted"
                : "Upload aborted"
            )
          );
        });

        xhr.send(file);
      });
    },
    []
  );

  const uploadFile = useCallback(
    async (file: File, onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<UploadResponse | null> => {
      const contentType = file.type || "application/octet-stream";
      if (!isAllowedUploadType(file.name, contentType)) {
        const typeError = new Error("Only image and font files are allowed");
        setError(typeError);
        options.onError?.(typeError);
        return null;
      }

      setIsUploading(true);
      setError(null);
      setProgress(0);

      try {
        setProgress(5);
        const uploadResponse = await requestUploadUrl(file, signal);

        setProgress(10);
        await uploadToPresignedUrl(file, uploadResponse.uploadURL, (xhrPct) => {
          setProgress(10 + Math.round(xhrPct * 0.85));
          onProgress?.(xhrPct);
        }, signal);

        setProgress(100);
        onProgress?.(100);
        options.onSuccess?.(uploadResponse);
        return uploadResponse;
      } catch (err) {
        const error = err instanceof Error ? err : new Error("Upload failed");
        setError(error);
        options.onError?.(error);
        return null;
      } finally {
        setIsUploading(false);
      }
    },
    [requestUploadUrl, uploadToPresignedUrl, options]
  );

  const getUploadParameters = useCallback(
    async (
      file: UppyFile<Record<string, unknown>, Record<string, unknown>>
    ): Promise<{
      method: "PUT";
      url: string;
      headers?: Record<string, string>;
    }> => {
      const contentType = file.type || "application/octet-stream";
      if (!isAllowedUploadType(file.name ?? "", contentType)) {
        throw new Error("Only image and font files are allowed");
      }

      const response = await fetch(`${basePath}/uploads/request-url`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          contentType: file.type || "application/octet-stream",
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to get upload URL");
      }

      const data = await response.json();
      return {
        method: "PUT",
        url: data.uploadURL,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      };
    },
    []
  );

  return {
    uploadFile,
    getUploadParameters,
    isUploading,
    error,
    progress,
  };
}
