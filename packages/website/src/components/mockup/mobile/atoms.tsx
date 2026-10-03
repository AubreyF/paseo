import { VorteoMark as BrandMark } from "../icons";

export function VorteoMark({ size = 20, className }: { size?: number; className?: string }) {
  return <BrandMark size={size} className={className} />;
}

/** A hashed identity tile — one letter on a muted identity fill. */
export function LetterTile({
  letter,
  tone,
}: {
  letter: string;
  tone: "red" | "violet" | "amber" | "teal";
}) {
  return (
    <span
      className={`flex size-[18px] shrink-0 items-center justify-center rounded-[5px] text-[10px] font-semibold text-white ${TILE_TONE[tone]}`}
    >
      {letter}
    </span>
  );
}

const TILE_TONE = {
  red: "bg-mock-tile-red",
  violet: "bg-mock-tile-violet",
  amber: "bg-mock-tile-amber",
  teal: "bg-mock-tile-teal",
} as const;

/** The Vorteo project tile uses the approved white signature. */
export function VorteoTile() {
  return (
    <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-black text-white">
      <VorteoMark size={14} />
    </span>
  );
}
