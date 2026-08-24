import type { SourceRange } from "../runtime/source-range.js";

export type MyBatisStatementKind = "select" | "insert" | "update" | "delete";
export type MyBatisParseState = "COMPLETE" | "FAILED";

export type MyBatisStatementFact = {
  statementId: string;
  namespace: string;
  id: string;
  kind: MyBatisStatementKind;
  parameterType?: string;
  resultType?: string;
  resultMap?: string;
  range?: SourceRange;
};

export type MyBatisResultMapFact = {
  resultMapId: string;
  namespace: string;
  id: string;
  type?: string;
  range?: SourceRange;
};

export type MyBatisMapperResourceFacts = {
  resourceId: string;
  relativePath: string;
  namespace: string;
  statements: MyBatisStatementFact[];
  resultMaps: MyBatisResultMapFact[];
  includes: Array<{ fromStatementId: string; refid: string }>;
  contentHash: string;
  generation: number;
  parseState: MyBatisParseState;
};

export function myBatisResourceId(relativePath: string): string {
  return `mybatis-resource:${relativePath}`;
}

export function myBatisQualifiedId(namespace: string, id: string): string {
  return `${namespace}.${id}`;
}

export function myBatisStatementId(namespace: string, id: string): string {
  return `mybatis-statement:${myBatisQualifiedId(namespace, id)}`;
}

export function myBatisResultMapId(namespace: string, id: string): string {
  return `mybatis-resultmap:${myBatisQualifiedId(namespace, id)}`;
}
