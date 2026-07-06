import { unique } from "./candidate-helpers.js";

export function classStem(baseName: string): string {
  return baseName.replace(/(Controller|AppService|Service|Assembler|Repository|Gateway|Command|Request|Response|View|VO|DTO|DO|Entity|Mapper|Parser|Port|Client|Job|Scheduler|Listener|Handler|Consumer|Event|Test)$/, "") || baseName;
}

export function taskKeywordStems(keywords: string[]): Array<{ stem: string; wordCount: number }> {
  const words = unique(keywords.flatMap(keywordWords))
    .filter(word => word.length >= 3)
    .map(capitalize);
  const stems: Array<{ stem: string; wordCount: number }> = [];
  for (let start = 0; start < words.length; start += 1) {
    for (let count = 1; count <= 4 && start + count <= words.length; count += 1) {
      stems.push({ stem: words.slice(start, start + count).join(""), wordCount: count });
    }
  }
  return stems;
}

export function actionTailRaw(symbol: string): string {
  const tail = symbol.replace(/^(get|find|list|load|resolve|create|update|delete|save|mark|claim)/, "");
  return tail && tail !== symbol ? tail : "";
}

export function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function keywordWords(keyword: string): string[] {
  return keyword
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(word => word.toLowerCase());
}
