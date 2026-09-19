import type { ReactNode } from "react";
import { View } from "react-native";
import type { PickedImageAttachmentInput } from "@/hooks/image-attachment-picker";
export function QueueEditMediaInput({
  children,
}: {
  children: ReactNode;
  add(images: PickedImageAttachmentInput[]): void;
  disabled: boolean;
  onError(message: string): void;
}) {
  return <View>{children}</View>;
}
