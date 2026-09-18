import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { TextInput } from "react-native";
import type { EditingTextInputHandle, EditingTextInputProps } from "./types";

export const EditingTextInput = forwardRef<EditingTextInputHandle, EditingTextInputProps>(
  function EditingTextInputWeb(allProps, ref) {
    const {
      initialValue = "",
      onChangeText,
      onExternalTextChange,
      onPasteImages: _,
      onPasteError: __,
      variant: ___,
      value: ____,
      defaultValue: _____,
      ...props
    } = allProps as EditingTextInputProps & { value?: unknown; defaultValue?: unknown };
    const inputRef = useRef<TextInput | null>(null);
    const initialTextRef = useRef(initialValue);
    const textRef = useRef(initialTextRef.current);
    const isComposingRef = useRef(false);
    const onChangeTextRef = useRef(onChangeText);
    onChangeTextRef.current = onChangeText;
    const externalChangeRef = useRef(onExternalTextChange);
    externalChangeRef.current = onExternalTextChange;

    const handleChangeText = useCallback((nextText: string) => {
      if (isComposingRef.current || nextText === textRef.current) return;
      textRef.current = nextText;
      onChangeTextRef.current?.(nextText);
    }, []);

    useEffect(() => {
      const input = inputRef.current as unknown as HTMLTextAreaElement | null;
      if (!input) return;

      const startComposition = () => {
        isComposingRef.current = true;
      };
      const publishInput = () => handleChangeText(input.value ?? "");
      // Assigning .value does not emit input or trigger a MutationObserver.
      // Check only the focused, visible editor, and publish only actual changes.
      const reconcileExternalValue = () => {
        if (document.hidden || document.activeElement !== input || isComposingRef.current) return;
        if ((input.value ?? "") === textRef.current) return;
        externalChangeRef.current?.();
        publishInput();
      };
      const reconciliation = window.setInterval(reconcileExternalValue, 200);
      const endComposition = () => {
        isComposingRef.current = false;
        publishInput();
      };

      // Injected dictation can assign .value before emitting input. React's
      // value tracker may suppress onChangeText for that already-tracked value.
      // Observe the committed DOM value too, deduplicating both notification paths.
      input.addEventListener("input", publishInput);
      input.addEventListener("change", publishInput);
      input.addEventListener("compositionstart", startComposition);
      input.addEventListener("compositionend", endComposition);
      return () => {
        window.clearInterval(reconciliation);
        input.removeEventListener("input", publishInput);
        input.removeEventListener("change", publishInput);
        input.removeEventListener("compositionstart", startComposition);
        input.removeEventListener("compositionend", endComposition);
      };
    }, [handleChangeText]);

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      isFocused: () => document.activeElement === inputRef.current,
      getText: () => {
        const input = inputRef.current as unknown as HTMLTextAreaElement | null;
        // A read must not consume the next input/composition notification.
        return input?.value ?? textRef.current;
      },
      replaceText: (nextText, selection) => {
        textRef.current = nextText;
        const input = inputRef.current as unknown as HTMLTextAreaElement | null;
        if (input && "value" in input) input.value = nextText;
        if (selection && typeof input?.setSelectionRange === "function") {
          input.setSelectionRange(selection.start, selection.end);
        }
      },
      getNativeRef: () => inputRef.current,
    }));

    return (
      <TextInput
        {...props}
        ref={inputRef}
        defaultValue={initialTextRef.current}
        onChangeText={handleChangeText}
      />
    );
  },
);
