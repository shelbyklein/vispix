import * as ImagePicker from "expo-image-picker";
import { useState, useCallback } from "react";
import { Alert, Platform } from "react-native";

import {
  useRequestUploadUrl,
  useUploadPhoto,
} from "@workspace/api-client-react";

async function uploadBlob(uploadURL: string, blob: Blob, contentType: string, uploadHeaders?: Record<string, string>): Promise<void> {
  // Send exactly the headers the server signed into the URL.
  const response = await fetch(uploadURL, {
    method: "PUT",
    headers: uploadHeaders && Object.keys(uploadHeaders).length > 0 ? uploadHeaders : { "Content-Type": contentType },
    body: blob,
  });
  if (!response.ok) {
    throw new Error(`Storage upload failed: ${response.status}`);
  }
}

async function uriToBlob(uri: string): Promise<Blob> {
  const response = await fetch(uri);
  return response.blob();
}

export type UploadSource = "camera" | "library";

export interface UsePhotoUploadOptions {
  albumId: number;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
}

export function usePhotoUpload({ albumId, onSuccess, onError }: UsePhotoUploadOptions) {
  const [isUploading, setIsUploading] = useState(false);
  const { mutateAsync: requestUrl } = useRequestUploadUrl();
  const { mutateAsync: uploadPhoto } = useUploadPhoto();

  const upload = useCallback(
    async (source: UploadSource) => {
      try {
        if (source === "camera") {
          const { status } = await ImagePicker.requestCameraPermissionsAsync();
          if (status !== "granted") {
            Alert.alert(
              "Camera access required",
              "Please enable camera access in your device settings to take photos."
            );
            return;
          }
        } else {
          const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (status !== "granted") {
            Alert.alert(
              "Photo library access required",
              "Please enable photo library access in your device settings to upload photos."
            );
            return;
          }
        }

        const result =
          source === "camera"
            ? await ImagePicker.launchCameraAsync({
                mediaTypes: ["images"],
                quality: 0.9,
                allowsEditing: false,
              })
            : await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ["images"],
                quality: 0.9,
                allowsEditing: false,
                allowsMultipleSelection: false,
              });

        if (result.canceled || !result.assets?.length) return;

        const asset = result.assets[0];
        const uri = asset.uri;
        const contentType = asset.mimeType ?? "image/jpeg";
        const rawFilename = uri.split("/").pop() ?? "photo.jpg";
        const filename = rawFilename.includes(".") ? rawFilename : `${rawFilename}.jpg`;

        setIsUploading(true);

        const blob = await uriToBlob(uri);

        const { uploadURL, objectPath, uploadHeaders } = await requestUrl({
          data: { name: filename, size: blob.size, contentType },
        });

        await uploadBlob(uploadURL, blob, contentType, uploadHeaders);

        await uploadPhoto({
          id: albumId,
          data: {
            url: `/api/storage${objectPath}`,
            storageKey: objectPath,
          },
        });

        onSuccess?.();
      } catch (err) {
        const error = err instanceof Error ? err : new Error("Upload failed");
        if (onError) {
          onError(error);
        } else {
          Alert.alert("Upload failed", error.message);
        }
      } finally {
        setIsUploading(false);
      }
    },
    [albumId, requestUrl, uploadPhoto, onSuccess, onError]
  );

  const showPicker = useCallback(() => {
    if (Platform.OS === "web") {
      upload("library");
      return;
    }
    Alert.alert("Upload Photo", "Choose a source", [
      { text: "Take Photo", onPress: () => void upload("camera") },
      { text: "Choose from Library", onPress: () => void upload("library") },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [upload]);

  return { showPicker, isUploading };
}
