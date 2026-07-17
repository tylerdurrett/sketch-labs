// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ImageAssetControl } from "./ImageAssetControl";

describe("ImageAssetControl", () => {
  it("shows a canonical identity, readable name, and its stable thumbnail URL", () => {
    const value = "pine-cone-0123456789ab";
    const html = renderToStaticMarkup(
      <ImageAssetControl paramKey="source" value={value} />,
    );

    expect(html).toContain("source");
    expect(html).toContain("pine cone");
    expect(html).toContain(`src="/image-assets/${value}.png"`);
    expect(html).toContain('alt="pine cone image asset thumbnail"');

    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.querySelector("code")?.textContent).toBe(value);
  });

  it("gives an unresolved canonical identity its own URL", () => {
    const unresolved = "not-in-the-catalog-abcdef012345";
    const html = renderToStaticMarkup(
      <ImageAssetControl paramKey="source" value={unresolved} />,
    );

    expect(html).toContain(unresolved);
    expect(html).toContain(`src="/image-assets/${unresolved}.png"`);
  });

  it("preserves a malformed identity without fabricating a URL or thumbnail", () => {
    const malformed = "../Pine Cone.png?raw=1";
    const html = renderToStaticMarkup(
      <ImageAssetControl paramKey="source" value={malformed} />,
    );

    expect(html).not.toContain("<img");
    expect(html).not.toContain("/image-assets/");

    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.querySelector("code")?.textContent).toBe(malformed);
  });
});
