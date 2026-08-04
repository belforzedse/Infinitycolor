const CODE128_PATTERNS = [
  "11011001100",
  "11001101100",
  "11001100110",
  "10010011000",
  "10010001100",
  "10001001100",
  "10011001000",
  "10011000100",
  "10001100100",
  "11001001000",
  "11001000100",
  "11000100100",
  "10110011100",
  "10011011100",
  "10011001110",
  "10111001100",
  "10011101100",
  "10011100110",
  "11001110010",
  "11001011100",
  "11001001110",
  "11011100100",
  "11001110100",
  "11101101110",
  "11101001100",
  "11100101100",
  "11100100110",
  "11101100100",
  "11100110100",
  "11100110010",
  "11011011000",
  "11011000110",
  "11000110110",
  "10100011000",
  "10001011000",
  "10001000110",
  "10110001000",
  "10001101000",
  "10001100010",
  "11010001000",
  "11000101000",
  "11000100010",
  "10110111000",
  "10110001110",
  "10001101110",
  "10111011000",
  "10111000110",
  "10001110110",
  "11101110110",
  "11010001110",
  "11000101110",
  "11011101000",
  "11011100010",
  "11011101110",
  "11101011000",
  "11101000110",
  "11100010110",
  "11101101000",
  "11101100010",
  "11100011010",
  "11101111010",
  "11001000010",
  "11110001010",
  "10100110000",
  "10100001100",
  "10010110000",
  "10010000110",
  "10000101100",
  "10000100110",
  "10110010000",
  "10110000100",
  "10011010000",
  "10011000010",
  "10000110100",
  "10000110010",
  "11000010010",
  "11001010000",
  "11110111010",
  "11000010100",
  "10001111010",
  "10100111100",
  "10010111100",
  "10010011110",
  "10111100100",
  "10011110100",
  "10011110010",
  "11110100100",
  "11110010100",
  "11110010010",
  "11011011110",
  "11011110110",
  "11110110110",
  "10101111000",
  "10100011110",
  "10001011110",
  "10111101000",
  "10111100010",
  "11110101000",
  "11110100010",
  "10111011110",
  "10111101110",
  "11101011110",
  "11110101110",
  "11010000100",
  "11010010000",
  "11010011100",
  "11000111010",
] as const;

type BarcodeBar = {
  x: number;
  width: number;
};

export type FactorchiBarcodeData = {
  bars: BarcodeBar[];
  height: number;
  value: string;
  width: number;
};

/**
 * Mirrors Factorchi_Barcode::svg(): Code 128 subset B, module width 2,
 * modulo-103 checksum, stop code 106, and the final two termination modules.
 */
export function encodeFactorchiCode128B(
  rawValue: string,
  height = 60,
  moduleWidth = 2,
): FactorchiBarcodeData | null {
  const value = rawValue.trim().replace(/[^\x20-\x7e]/g, "");
  if (!value) return null;

  const codes = [104, ...Array.from(value, (character) => character.charCodeAt(0) - 32)];
  const checksum = codes.reduce((sum, code, index) => sum + (index === 0 ? code : code * index), 0);
  codes.push(checksum % 103, 106);

  const binary = `${codes.map((code) => CODE128_PATTERNS[code]).join("")}11`;
  const bars: BarcodeBar[] = [];
  let x = 0;
  let black = false;
  let run = 0;

  for (let index = 0; index <= binary.length; index += 1) {
    const bit = index < binary.length ? binary[index] : null;
    if (bit === "1") {
      if (!black) {
        black = true;
        run = 1;
      } else {
        run += 1;
      }
    } else {
      if (black) {
        const width = run * moduleWidth;
        bars.push({ x, width });
        x += width;
        black = false;
        run = 0;
      }
      if (bit === "0") x += moduleWidth;
    }
  }

  return {
    bars,
    height,
    value,
    width: Math.max(x, 1),
  };
}

export default function FactorchiBarcode({
  value,
  height = 60,
}: {
  value: string;
  height?: number;
}) {
  const barcode = encodeFactorchiCode128B(value, height);
  if (!barcode) return null;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={barcode.width}
      height={barcode.height}
      viewBox={`0 0 ${barcode.width} ${barcode.height}`}
      role="img"
      aria-label={barcode.value}
      data-testid="invoice-barcode"
      data-format="CODE128B"
      data-value={barcode.value}
    >
      {barcode.bars.map((bar) => (
        <rect key={bar.x} x={bar.x} y={0} width={bar.width} height={barcode.height} fill="#000" />
      ))}
    </svg>
  );
}
