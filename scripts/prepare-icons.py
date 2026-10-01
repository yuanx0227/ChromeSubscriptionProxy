"""Resize the approved generated logo for Chrome; no image generation here."""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[1]
generated = Image.open(root / 'output/imagegen/qingkong-logo.png').convert('RGBA')
# The image service returned alpha despite an opaque-background prompt.
# Composite explicitly, preserving the generated mark rather than discarding alpha to black.
image = Image.alpha_composite(Image.new('RGBA', generated.size, '#315eea'), generated).convert('RGB')
image.save(root / 'output/imagegen/qingkong-logo-app.png', optimize=True)
dest = root / 'extension/public/icons'
dest.mkdir(parents=True, exist_ok=True)
for size in (16, 32, 48, 128, 256):
    image.resize((size, size), Image.Resampling.LANCZOS).save(dest / f'icon{size}.png', optimize=True)
print('Generated logo resized to Chrome icon sizes.')
