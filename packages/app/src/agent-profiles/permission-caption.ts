export function permissionCaption(label: string, vorton: boolean, compact = false): string {
  if (!vorton) return label;
  if (compact) {
    return permissionCaption(label, true).slice(0, 1).toUpperCase();
  }
  switch (label.toLowerCase().replace(/[\s_-]+/g, "")) {
    case "autoreview":
      return "Auto";
    case "fullaccess":
      return "Full";
    case "defaultpermissions":
      return "Default";
    default:
      return label;
  }
}
