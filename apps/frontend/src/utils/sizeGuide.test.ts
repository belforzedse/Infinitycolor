import { normalizeSizeGuideData, serializeSizeGuideMatrix } from "./sizeGuide";

it("keeps unnamed columns separate while displaying and saving dash headers", () => {
  const input = [["سایز", "", "   ", "قد"], ["M", "50", "60", "70"], ["L", "", "65", ""]];
  const { rows, columns } = normalizeSizeGuideData(input);

  expect(columns.map((column) => column.title)).toEqual(["---", "---", "قد"]);
  expect(new Set(columns.map((column) => column.key)).size).toBe(3);
  const saved = [["سایز", "---", "---", "قد"], ...input.slice(1)];
  expect(serializeSizeGuideMatrix(rows, columns)).toEqual(saved);
  const reloaded = normalizeSizeGuideData(saved);
  expect(serializeSizeGuideMatrix(reloaded.rows, reloaded.columns)).toEqual(saved);
});

it("uses the placeholder for unsaved blank titles without exposing column keys", () => {
  expect(serializeSizeGuideMatrix([{ size: "M", first: "50", second: "60" }], [
    { key: "first", title: "" }, { key: "second", title: "   " },
  ])).toEqual([["سایز", "---", "---"], ["M", "50", "60"]]);
});

it("preserves named duplicate measurements and legacy object rows", () => {
  const { rows, columns } = normalizeSizeGuideData([["سایز", "قد", "قد"], ["M", "50", "60"]]);
  expect(serializeSizeGuideMatrix(rows, columns)).toEqual([["سایز", "قد", "قد (2)"], ["M", "50", "60"]]);
  const legacy = normalizeSizeGuideData([{ size: "M", "": "50", قد: "60" }]);
  expect(serializeSizeGuideMatrix(legacy.rows, legacy.columns)).toEqual([["سایز", "---", "قد"], ["M", "50", "60"]]);
});
