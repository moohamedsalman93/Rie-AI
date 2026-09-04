import { useState, useCallback } from "react";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
const TEXT_EXTENSIONS = [
  "txt", "md", "py", "js", "ts", "json", "csv", "xml", "yaml", "yml",
  "html", "css", "log", "env", "toml", "ini", "cfg", "sh", "bat", "ps1",
  "sql", "java", "c", "cpp", "h", "go", "rs", "rb", "php", "r", "jsx",
  "tsx", "vue", "svelte", "swift", "kt", "dart", "lua", "pl", "makefile",
  "dockerfile", "gitignore", "editorconfig", "prettierrc", "eslintrc",
];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_FILES = 5;

export function useAttachments() {
  const [attachedImage, setAttachedImage] = useState(null);
  const [isScreenAttached, setIsScreenAttached] = useState(false);
  const [projectRoot, setProjectRoot] = useState(null);
  const [projectRootChip, setProjectRootChip] = useState(null);
  const [attachedClipboardText, setAttachedClipboardText] = useState(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isAttachmentPopoverOpen, setIsAttachmentPopoverOpen] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState([]);

  const handlePickProjectPath = useCallback(async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Select Project Root"
      });

      if (selected) {
        const rawPath = Array.isArray(selected) ? selected[0] : (typeof selected === "object" && selected !== null ? selected.path || String(selected) : selected);
        if (typeof rawPath === "string" && rawPath.trim()) {
          const cleanPath = rawPath.trim();
          setProjectRoot(cleanPath);
          const parts = cleanPath.split(/[/\\]/).filter(Boolean);
          setProjectRootChip(parts[parts.length - 1] || cleanPath);
        }
      }
    } catch (err) {
      console.warn("Tauri dialog not available or failed, prompting user:", err);
      const manualPath = window.prompt("Enter absolute project/workspace path (e.g. D:\\my-project):");
      if (manualPath && manualPath.trim()) {
        const clean = manualPath.trim();
        setProjectRoot(clean);
        const parts = clean.split(/[/\\]/).filter(Boolean);
        setProjectRootChip(parts[parts.length - 1] || clean);
      }
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
    if (file.type?.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = (re) => {
        setAttachedImage(re.target.result);
        setIsScreenAttached(false);
      };
      reader.readAsDataURL(file);
    } else {
      // Non-image file: read as text
      if (file.size > MAX_FILE_SIZE) {
        console.warn("File too large:", file.name);
        return;
      }
      const reader = new FileReader();
      reader.onload = (re) => {
        setAttachedFiles((prev) => {
          if (prev.length >= MAX_FILES) return prev;
          if (prev.some((f) => f.name === file.name)) return prev;
          return [...prev, { name: file.name, content: re.target.result, size: file.size }];
        });
      };
      reader.readAsText(file);
    }
  }, []);

  const processFilePath = useCallback(async (path) => {
    if (!path) return;

    const ext = path.split(".").pop().toLowerCase();

    // Image files
    if (IMAGE_EXTENSIONS.includes(ext)) {
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
        console.error("Failed to process image file path:", err);
      }
      return;
    }

    // Text/code files
    if (TEXT_EXTENSIONS.includes(ext) || !ext) {
      try {
        const { readFile } = await import("@tauri-apps/plugin-fs");
        const contents = await readFile(path);
        const bytes = new Uint8Array(contents);
        if (bytes.byteLength > MAX_FILE_SIZE) {
          console.warn("File too large:", path);
          return;
        }
        const decoder = new TextDecoder("utf-8");
        const text = decoder.decode(bytes);
        const fileName = path.split(/[/\\]/).pop() || path;
        setAttachedFiles((prev) => {
          if (prev.length >= MAX_FILES) return prev;
          if (prev.some((f) => f.name === fileName)) return prev;
          return [...prev, { name: fileName, content: text, size: bytes.byteLength }];
        });
      } catch (err) {
        console.error("Failed to process text file path:", err);
      }
    }
  }, []);

  const removeAttachedFile = useCallback((index) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleFileUpload = useCallback(async () => {
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const { readFile } = await import('@tauri-apps/plugin-fs');

      const allExts = [...IMAGE_EXTENSIONS, ...TEXT_EXTENSIONS];
      const file = await openDialog({
        multiple: true,
        filters: [
          { name: 'All Supported', extensions: allExts },
          { name: 'Images', extensions: [...IMAGE_EXTENSIONS] },
          { name: 'Code & Text', extensions: [...TEXT_EXTENSIONS] },
        ]
      });

      if (!file) {
        setIsAttachmentPopoverOpen(false);
        return;
      }

      const paths = Array.isArray(file) ? file : [file];

      for (const filePath of paths) {
        const ext = filePath.split(".").pop().toLowerCase();

        if (IMAGE_EXTENSIONS.includes(ext)) {
          // Image: set as attachedImage (last one wins)
          const contents = await readFile(filePath);
          let binary = '';
          const bytes = new Uint8Array(contents);
          const len = bytes.byteLength;
          for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const mimeExt = ext === "jpg" ? "jpeg" : ext;
          const base64 = `data:image/${mimeExt};base64,${window.btoa(binary)}`;
          setAttachedImage(base64);
          setIsScreenAttached(false);
        } else {
          // Text/code file
          const contents = await readFile(filePath);
          const bytes = new Uint8Array(contents);
          if (bytes.byteLength > MAX_FILE_SIZE) {
            console.warn("File too large, skipping:", filePath);
            continue;
          }
          const decoder = new TextDecoder("utf-8");
          const text = decoder.decode(bytes);
          const fileName = filePath.split(/[/\\]/).pop() || filePath;
          setAttachedFiles((prev) => {
            if (prev.length >= MAX_FILES) return prev;
            if (prev.some((f) => f.name === fileName)) return prev;
            return [...prev, { name: fileName, content: text, size: bytes.byteLength }];
          });
        }
      }
    } catch (err) {
      console.error("Failed to pick file:", err);
      // Fallback for non-Tauri environments
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*,.txt,.md,.py,.js,.ts,.json,.csv,.xml,.yaml,.yml,.html,.css,.log,.sql,.java,.c,.cpp,.go,.rs,.rb,.jsx,.tsx';
      input.multiple = true;
      input.onchange = (e) => {
        const files = Array.from(e.target.files || []);
        for (const f of files) {
          if (f.type?.startsWith("image/")) {
            const reader = new FileReader();
            reader.onload = (re) => {
              setAttachedImage(re.target.result);
              setIsScreenAttached(false);
            };
            reader.readAsDataURL(f);
          } else {
            if (f.size > MAX_FILE_SIZE) {
              console.warn("File too large:", f.name);
              continue;
            }
            const reader = new FileReader();
            reader.onload = (re) => {
              setAttachedFiles((prev) => {
                if (prev.length >= MAX_FILES) return prev;
                if (prev.some((existing) => existing.name === f.name)) return prev;
                return [...prev, { name: f.name, content: re.target.result, size: f.size }];
              });
            };
            reader.readAsText(f);
          }
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
    attachedFiles,
    setAttachedFiles,
    removeAttachedFile,
    handlePickProjectPath,
    handleAttachClipboard,
    handleFileUpload,
    handleCaptureScreen,
    processFile,
    processFilePath,
  };
}
