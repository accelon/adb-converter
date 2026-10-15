/**
 * Delphi's TStringList.QuickSort, ported so that the tie order of equal keys is
 * reproduced exactly.
 *
 * The Delphi writer sorts the values of `attributes.sorted` with
 * TWideStrings.CustomSort, which is Classes.pas:
 *
 *   procedure TStringList.QuickSort(L, R: Integer; SCompare: TStringListSortCompare);
 *   var I, J, P: Integer;
 *   begin
 *     repeat
 *       I := L; J := R; P := (L + R) shr 1;
 *       repeat
 *         while SCompare(Self, I, P) < 0 do Inc(I);
 *         while SCompare(Self, J, P) > 0 do Dec(J);
 *         if I <= J then begin
 *           if I <> J then ExchangeItems(I, J);
 *           if P = I then P := J else if P = J then P := I;
 *           Inc(I); Dec(J);
 *         end;
 *       until I > J;
 *       if L < J then QuickSort(L, J, SCompare);
 *       L := I;
 *     until I >= R;
 *   end;
 *
 * This quicksort is not stable, so a stable Array.sort produces a different
 * permutation for equal keys (verified: yinshun's `聯.i` block has an identical
 * (value, docnode) multiset but a different order for the equal values).
 */
export function delphiQuickSort<T>(items: T[], compare: (a: T, b: T) => number): void {
  if (items.length < 2) return;
  const swap = (i: number, j: number): void => {
    const t = items[i];
    items[i] = items[j];
    items[j] = t;
  };
  const qs = (L: number, R: number): void => {
    let l = L;
    for (;;) {
      let i = l;
      let j = R;
      let p = (l + R) >> 1;
      do {
        while (compare(items[i], items[p]) < 0) i++;
        while (compare(items[j], items[p]) > 0) j--;
        if (i <= j) {
          if (i !== j) swap(i, j);
          if (p === i) p = j;
          else if (p === j) p = i;
          i++;
          j--;
        }
      } while (i <= j);
      if (l < j) qs(l, j);
      l = i;
      if (i >= R) break;
    }
  };
  qs(0, items.length - 1);
}
