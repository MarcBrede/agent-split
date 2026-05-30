export function commonPrefixDelta(parent: string[], child: string[]): string[] {
  let index = 0;
  while (
    index < parent.length &&
    index < child.length &&
    parent[index] === child[index]
  ) {
    index += 1;
  }

  return child.slice(index);
}
