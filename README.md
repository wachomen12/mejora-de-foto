# PixelBoost

App web para mejorar fotos. **100% gratis, sin backend, sin API keys.**

Usa Pica (Lanczos + unsharp mask) corriendo en el navegador del visitante: no hay costos para ti ni para él, y los resultados son instantáneos.

## Probar en local

Solo abre `index.html` con doble clic, o usa cualquier servidor estático. Por ejemplo:

```powershell
npx serve .
```

## Desplegar en Vercel (gratis)

### Opción 1 — Desde GitHub (recomendada)

1. Crea un repositorio en https://github.com y sube esta carpeta.
2. Entra a https://vercel.com y conéctate con GitHub.
3. Clic en **"Add New → Project"**, selecciona tu repo, **Deploy**.
4. En 30 segundos tendrás una URL tipo `pixelboost-tunombre.vercel.app` para compartir.

### Opción 2 — Desde tu PC con la CLI

```powershell
npm i -g vercel
vercel
```

Sigue las preguntas (acepta los defaults) y te da la URL.

## Notas

- Sin descarga de modelos pesados — Pica son ~30 KB.
- Procesamiento instantáneo (~1–3 s por foto).
- JPG, PNG y WEBP hasta 10 MB.
- No requiere tarjeta, no requiere cuenta, no requiere nada.
