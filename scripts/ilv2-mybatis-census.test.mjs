import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { censusCorpus, classifyGold, isMapperXml, javaSignals, statementCount } from "./ilv2-mybatis-census.mjs";

const MAPPER = `<?xml version="1.0"?>\n<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "x.dtd">\n<!-- <select id="commented"> -->\n<mapper namespace="a.UserMapper">\n  <select id="one">x</select>\n  <update id="two">y</update>\n  <sql id="cols">z</sql>\n</mapper>\n`;

test("mapper XML and statement counts follow the index root-tag rule", () => {
  assert.equal(isMapperXml(MAPPER), true);
  assert.equal(isMapperXml(`<?xml version="1.0"?>\n<configuration><logger name="mapper"/></configuration>`), false);
  assert.equal(isMapperXml(`<project><artifactId>mapper</artifactId></project>`), false);
  assert.equal(statementCount(MAPPER), 2, "commented statements and <sql> fragments do not count");
});

test("Java signals separate annotation mappers from MyBatis-Plus", () => {
  assert.deepEqual(javaSignals("@Mapper public interface M extends BaseMapper<User> {}"),
    { mapperAnnotation: true, plusBaseMapper: true, plusService: false, plusWrapper: false, sqlAnnotation: false });
  assert.equal(javaSignals("new LambdaQueryWrapper<User>()").plusWrapper, true);
  assert.equal(javaSignals("class S extends ServiceImpl<M, User> {}").plusService, true);
  assert.equal(javaSignals(`@Select("select 1") int one();`).sqlAnnotation, true);
  assert.equal(javaSignals("@MapperScan(\"a\") class App {}").mapperAnnotation, false);
});

test("corpus census skips tests and build output; gold ranges are classified per corpus", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mb-census-"));
  const put = async (file, text) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); };
  await put("app/src/main/resources/mapper/UserMapper.xml", MAPPER);
  await put("app/src/main/resources/logback.xml", "<configuration/>");
  await put("app/src/main/java/a/UserMapper.java", "@Mapper interface UserMapper { User one(); }");
  await put("app/src/main/java/a/Svc.java", "class Svc {}");
  await put("app/src/test/resources/TestMapper.xml", MAPPER);
  await put("app/target/classes/mapper/UserMapper.xml", MAPPER);
  const census = await censusCorpus(root);
  assert.deepEqual(census.counts, { xmlFiles: 2, mapperXmlFiles: 1, mapperStatements: 2, javaFiles: 2, mapperAnnotation: 1, plusBaseMapper: 0, plusService: 0, plusWrapper: 0, sqlAnnotation: 0 });
  const gold = classifyGold([
    { ranges: [{ path: "app/src/main/resources/mapper/UserMapper.xml" }, { path: "app/src/main/java/a/Svc.java" }] },
    { ranges: [{ path: "app/src/main/resources/logback.xml" }, { path: "app/src/main/java/a/UserMapper.java" }] },
    { ranges: [{ path: "app/src/main/java/a/Svc.java" }] }
  ], census);
  assert.deepEqual(gold, { ranges: 5, mapperXml: 1, mapperJava: 1, otherXml: 1, tasksTouchingMyBatis: 2 });
});
