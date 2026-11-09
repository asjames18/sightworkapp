import type { Metadata } from "next";
import { SightWorkFlow } from "@/components/SightWorkFlow";
import { EXAMPLES, findExample } from "@/lib/examples";

/**
 * An example plan, prerendered. Reached through `/start?view=example&ex=<id>` (a rewrite in next.config.ts
 * keeps that URL in the address bar), so the plan is in the first HTML instead of swapping in after the
 * upload screen. Unknown ids (and "featured") show the featured example.
 */
export function generateStaticParams() {
  return [{ id: "featured" }, ...EXAMPLES.map((e) => ({ id: e.id }))];
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const example = findExample((await params).id);
  return {
    title: `${example.title}: ${example.kind === "real" ? "real run" : "sample plan"} | SightWork`,
    description: example.blurb,
  };
}

export default async function ExamplePlan({ params }: { params: Promise<{ id: string }> }) {
  return <SightWorkFlow initialExampleId={findExample((await params).id).id} />;
}
