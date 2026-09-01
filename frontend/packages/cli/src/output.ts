/** Print `data` as JSON when `--json` was passed, otherwise print `text` (human-readable). */
export function printResult(json: boolean | undefined, data: unknown, text: string): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(text);
  }
}
