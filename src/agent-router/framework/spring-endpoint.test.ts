import assert from "node:assert/strict";
import test from "node:test";
import { composeEndpointFact, httpMethodsFromArgumentsText, mappingOf, pathsFromArgumentsText } from "./spring-endpoint.js";

test("pathsFromArgumentsText: positional string literal", () => {
  assert.deepEqual(pathsFromArgumentsText('("/orders")'), ["/orders"]);
});

test("pathsFromArgumentsText: positional array literal", () => {
  assert.deepEqual(pathsFromArgumentsText('({"/x", "/y"})'), ["/x", "/y"]);
});

test("pathsFromArgumentsText: named value= argument alongside an unrelated named argument", () => {
  assert.deepEqual(pathsFromArgumentsText('(value = "/z", method = RequestMethod.GET)'), ["/z"]);
});

test("pathsFromArgumentsText: no arguments at all", () => {
  assert.deepEqual(pathsFromArgumentsText(undefined), []);
});

test("pathsFromArgumentsText: named arguments present but none is value/path - unknown, not guessed", () => {
  assert.deepEqual(pathsFromArgumentsText("(method = RequestMethod.GET)"), []);
});

test("pathsFromArgumentsText: a constant reference is left unparsed rather than guessed", () => {
  assert.deepEqual(pathsFromArgumentsText("(ApiPaths.ORDERS)"), []);
});

test("pathsFromArgumentsText: a concatenated string is unknown rather than its literal prefix", () => {
  assert.deepEqual(pathsFromArgumentsText('(\"/orders\" + suffix)'), []);
});

test("httpMethodsFromArgumentsText: extracts RequestMethod.X constants", () => {
  assert.deepEqual(httpMethodsFromArgumentsText("(method = RequestMethod.GET)"), ["GET"]);
  assert.deepEqual(httpMethodsFromArgumentsText('("/orders")'), []);
});

test("mappingOf: a GetMapping annotation yields its fixed HTTP verb plus parsed paths", () => {
  const mapping = mappingOf([
    { name: "GetMapping", resolvedFqn: "org.springframework.web.bind.annotation.GetMapping", argumentsText: '("/x")' }
  ]);
  assert.deepEqual(mapping, { httpMethods: ["GET"], paths: ["/x"] });
});

test("mappingOf: a plain RequestMapping with no arguments yields no httpMethods/paths but is still recognized", () => {
  const mapping = mappingOf([
    { name: "RequestMapping", resolvedFqn: "org.springframework.web.bind.annotation.RequestMapping" }
  ]);
  assert.deepEqual(mapping, { httpMethods: [], paths: [] });
});

test("mappingOf: no mapping annotation present at all", () => {
  assert.equal(mappingOf([{ name: "Service", resolvedFqn: "org.springframework.stereotype.Service" }]), undefined);
});

test("composeEndpointFact: joins a class-level prefix with a path-less method mapping", () => {
  const fact = composeEndpointFact("m1", { httpMethods: [], paths: ["/orders"] }, { httpMethods: ["POST"], paths: [] });
  assert.deepEqual(fact, { methodId: "m1", httpMethods: ["POST"], paths: ["/orders"] });
});

test("composeEndpointFact: an unknown method path does not become a known class prefix", () => {
  const classMapping = mappingOf([
    { name: "RequestMapping", resolvedFqn: "org.springframework.web.bind.annotation.RequestMapping", argumentsText: '("/orders")' }
  ])!;
  const methodMapping = mappingOf([
    { name: "GetMapping", resolvedFqn: "org.springframework.web.bind.annotation.GetMapping", argumentsText: '("/" + suffix)' }
  ])!;

  assert.deepEqual(
    composeEndpointFact("m1", classMapping, methodMapping),
    { methodId: "m1", httpMethods: ["GET"], paths: [] }
  );
});

test("composeEndpointFact: joins a class-level prefix with a method-level sub-path", () => {
  const fact = composeEndpointFact("m1", { httpMethods: [], paths: ["/orders"] }, { httpMethods: ["GET"], paths: ["/{id}"] });
  assert.deepEqual(fact, { methodId: "m1", httpMethods: ["GET"], paths: ["/orders/{id}"] });
});

test("composeEndpointFact: no class-level mapping - method mapping used as-is", () => {
  const fact = composeEndpointFact("m1", undefined, { httpMethods: ["GET"], paths: ["/x"] });
  assert.deepEqual(fact, { methodId: "m1", httpMethods: ["GET"], paths: ["/x"] });
});
