import { useEffect, useRef, type ReactNode } from "react";
import { View } from "react-native";
import type { PickedImageAttachmentInput } from "@/hooks/image-attachment-picker";

// A nested event boundary keeps media paste/drop out of the main composer.
export function QueueEditMediaInput({
  children,
  add,
  disabled,
  onError,
}: {
  children: ReactNode;
  add(images: PickedImageAttachmentInput[]): void;
  disabled: boolean;
  onError(message: string): void;
}) {
  const target = useRef<View>(null);
  useEffect(() => {
    const node = target.current as unknown as HTMLElement | null;
    if (!node) return;
    const accept = (files: File[]) => {
      if (disabled) return;
      if (files.some((file) => !file.type.startsWith("image/"))) {
        onError("Only images can be added here. Existing files can still be removed.");
        return;
      }
      add(
        files
          .filter((file) => file.type.startsWith("image/"))
          .map((file) => ({
            source: { kind: "blob", blob: file },
            mimeType: file.type,
            fileName: file.name,
          })),
      );
    };
    const paste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (!files.length) return;
      event.stopPropagation();
      event.preventDefault();
      accept(files);
    };
    const drag = (event: DragEvent) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
      event.stopPropagation();
      event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.files.length) return;
      event.stopPropagation();
      event.preventDefault();
      accept(Array.from(event.dataTransfer.files));
    };
    node.addEventListener("paste", paste);
    node.addEventListener("dragover", drag);
    node.addEventListener("drop", drop);
    return () => {
      node.removeEventListener("paste", paste);
      node.removeEventListener("dragover", drag);
      node.removeEventListener("drop", drop);
    };
  }, [add, disabled, onError]);
  return <View ref={target}>{children}</View>;
}
