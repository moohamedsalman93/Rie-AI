import { useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";

export function useAttachments() {
  const [attachedImage, setAttachedImage] = useState(null);
  const [isScreenAttached, setIsScreenAttached] = useState(false);
  const [projectRoot, setProjectRoot] = useState(null);
  const [projectRootChip, setProjectRootChip] = useState(null);
  const [attachedClipboardText, setAttachedClipboardText] = useState(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isAttachmentPopoverOpen, setIsAttachmentPopoverOpen] = useState(false);

  const handlePickProjectPath = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Project Root"
      });

      if (selected) {
        setProjectRoot(selected);
        const parts = selected.split(/[/\\]/);
        setProjectRootChip(parts[parts.length - 1] || selected);
      }
    } catch (err) {
      console.error("Failed to pick directory:", err);
    }
    setIsAttachmentPopoverOpen(false);
  }, []);

  const handleAttachClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        setAttachedClipboardText(text);
      }
    } catch (err) {
      console.error("Failed to read clipboard:", err);
    }
    setIsAttachmentPopoverOpen(false);
  }, []);

  const processFile = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (re) => {
      setAttachedImage(re.target.result);
      setIsScreenAttached(false);
    };
    reader.readAsDataURL(file);
  }, []);

  const processFilePath = useCallback(async (path) => {
    if (!path) return;

    // Check if it's an image
    const ext = path.split(".").pop().toLowerCase();
    const imageExtensions = ["png", "jpg", "jpeg", "webp", "gif"];
    if (!imageExtensions.includes(ext)) return;

    try {
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const contents = await readFile(path);
      const bytes = new Uint8Array(contents);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = `data:image/${
        ext === "jpg" ? "jpeg" : ext
      };base64,${window.btoa(binary)}`;
      setAttachedImage(base64);
      setIsScreenAttached(false);
    } catch (err) {
      console.error("Failed to process file path:", err);
    }
  }, []);

  const handleFileUpload = useCallback(async () => {
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const { readFile } = await import('@tauri-apps/plugin-fs');
      const file = await openDialog({
        multiple: false,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
      });
      if (file) {
        const contents = await readFile(file);
        let binary = '';
        const bytes = new Uint8Array(contents);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = `data:image/jpeg;base64,${window.btoa(binary)}`;
        setAttachedImage(base64);
        setIsScreenAttached(false);
      }
    } catch (err) {
      console.error("Failed to pick image:", err);
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = (re) => {
            setAttachedImage(re.target.result);
            setIsScreenAttached(false);
          };
          reader.readAsDataURL(file);
        }
      };
      input.click();
    }
    setIsAttachmentPopoverOpen(false);
  }, []);

  const handleCaptureScreen = useCallback(() => {
    setIsScreenAttached(true);
    setAttachedImage(null);
    setIsAttachmentPopoverOpen(false);
  }, []);

  return {
    attachedImage,
    setAttachedImage,
    isScreenAttached,
    setIsScreenAttached,
    projectRoot,
    setProjectRoot,
    projectRootChip,
    setProjectRootChip,
    attachedClipboardText,
    setAttachedClipboardText,
    isCapturing,
    setIsCapturing,
    isAttachmentPopoverOpen,
    setIsAttachmentPopoverOpen,
    handlePickProjectPath,
    handleAttachClipboard,
    handleFileUpload,
    handleCaptureScreen,
    processFile,
    processFilePath,
  };
}
