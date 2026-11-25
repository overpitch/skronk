import * as THREE from "three";

/**
 * Loads `<root>/<name>.png`. Surfaces carry UVs in texels, so each texture's
 * `repeat` is set to 1/size once its real size is known. Missing textures get a
 * generated checkerboard so a typo shows up clearly instead of breaking the map.
 */
export class TextureLibrary {
  private cache = new Map<string, THREE.Texture>();
  private loader = new THREE.TextureLoader();

  constructor(
    private root: string,
    private maxAnisotropy: number,
  ) {}

  get(name: string): THREE.Texture {
    let tex = this.cache.get(name);
    if (tex) return tex;
    tex = this.placeholder(name);
    this.cache.set(name, tex);
    const url = `${this.root}/${name}.png`;
    this.loader.load(
      url,
      (loaded) => {
        const img = loaded.image as { width: number; height: number };
        tex!.image = loaded.image;
        tex!.repeat.set(1 / img.width, 1 / img.height);
        tex!.needsUpdate = true;
      },
      undefined,
      () => console.warn(`[textures] missing ${url}, using placeholder`),
    );
    return tex;
  }

  private placeholder(name: string): THREE.Texture {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
    const hue = Math.abs(h) % 360;
    for (let y = 0; y < size; y += 16) {
      for (let x = 0; x < size; x += 16) {
        ctx.fillStyle = ((x + y) / 16) % 2 ? `hsl(${hue} 70% 55%)` : `hsl(${hue} 50% 25%)`;
        ctx.fillRect(x, y, 16, 16);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.maxAnisotropy;
    tex.magFilter = THREE.NearestFilter;
    tex.repeat.set(1 / size, 1 / size);
    return tex;
  }
}
