import { describe, expect, it } from "vitest";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { physicalTextSchema } from "@reelwalk/core";
import { PhysicalTextPanel } from "./physical-text-panel";
function elements(node:unknown):ReactElement<Record<string,unknown>>[] {
 if (Array.isArray(node)) return node.flatMap(elements);
 if (!React.isValidElement<Record<string,unknown>>(node)) return [];
 return [node,...elements(node.props.children)];
}
describe("physical title controls",()=>{
 it("is off by default and refuses unsupported characters with actionable feedback",()=>{
  const markup=renderToStaticMarkup(React.createElement(PhysicalTextPanel,{draft:{size:1,text:"\u6b22\u8fce"},onChange:()=>{}}));
  expect(markup).toContain("disabled");expect(markup).toContain("Choose flat text");expect(markup).not.toContain("checked");
 });
 it("enables bounded defaults and lets the customer change scene lighting",()=>{
  let value:unknown;
  const controls=elements(PhysicalTextPanel({draft:{size:1,text:"A real home"},onChange:v=>{value=v;}}));
  (controls.find(e=>e.type === "input")!.props.onChange as (e:unknown)=>void)({target:{checked:true}});
  expect(value).toEqual(physicalTextSchema.parse({}));
  const selected=elements(PhysicalTextPanel({draft:{size:1,text:"A real home",physical3d:physicalTextSchema.parse({})},onChange:v=>{value=v;}}));
  (selected.find(e=>e.type === "select")!.props.onChange as (e:unknown)=>void)({target:{value:"right"}});
  expect(value).toMatchObject({light:"right"});
  const markup=renderToStaticMarkup(React.createElement(PhysicalTextPanel,{draft:{size:1,text:"A real home",physical3d:physicalTextSchema.parse({})},onChange:()=>{}}));
  expect(markup).toContain("No automatic reconstruction");expect(markup).toContain("hold until the cut");
 });
});
