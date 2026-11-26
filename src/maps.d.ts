/** The maps in public/assets/maps, listed at build time by the skronk-maps plugin in vite.config.ts. */
declare module "virtual:maps" {
  const maps: readonly { name: string; title: string }[];
  export default maps;
}
