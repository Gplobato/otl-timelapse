
# Timelapse com filtro automático de frames defeituosos

## Diagnóstico das amostras

As 3 fotos "ruins" não têm listras finas — são frames com **grandes regiões de cor sólida (branco/cinza uniforme)** ocupando boa parte da imagem (uma totalmente branca, outra com a metade inferior cinza sólido, outra praticamente toda branca). As 2 boas são fotos completas, ricas em textura.

Isso simplifica o detector: em vez de procurar listras sutis, basta medir **quanto da imagem é uma faixa de cor uniforme** (variância local praticamente zero). Detecção fica precisa e rápida.

## Fluxo do app

1. **Upload** — dropzone aceitando pasta inteira ou seleção múltipla de JPGs. Mostra contagem, tamanho total, ordenação alfabética (padrão de timelapse com timestamp no nome).
2. **Análise + render automáticos** — uma única ação "Gerar timelapse". Sem revisão manual.
3. **Resultado** — player do MP4 + botão de download + resumo (`1.962 usadas · 38 descartadas de 2.000`).

## Detector de frames defeituosos

Roda em Web Workers (paralelizado pelo número de cores da máquina). Para cada foto:

1. Decodifica via `createImageBitmap`, redimensiona para 320px de largura em `OffscreenCanvas` (rápido).
2. Converte para escala de cinza.
3. Divide a imagem em **faixas horizontais de 8 pixels** de altura.
4. Para cada faixa, calcula a variância dos pixels.
5. Marca a faixa como "morta" se a variância < limiar (cor praticamente uniforme).
6. Se **≥ 25% das faixas estão mortas** → foto descartada.

Esse critério pega:
- Foto totalmente branca (100% das faixas mortas)
- Foto com metade cinza sólida (50% mortas)
- Faixas finas no meio da imagem (acumulam até passar do limiar se forem muitas)

E **não** pega as boas, que têm textura em todas as faixas (céu, telhados, vegetação geram variância natural).

Vou calibrar os limiares finais rodando o detector nas 5 amostras e confirmando que classifica corretamente antes de liberar.

## Geração do vídeo

- `@ffmpeg/ffmpeg` (wasm) rodando em Web Worker dedicado
- 1080p, 30fps, H.264, yuv420p, CRF 18, sem áudio
- Frames mantêm a ordem alfabética dos arquivos originais
- Para evitar estouro de memória com 2.000 fotos, renderizo em **lotes de ~300 frames** gerando segmentos MP4 intermediários e concatenando no final (`ffmpeg -f concat`)

## Arquitetura técnica

**Tudo roda no navegador do usuário.** Justificativa:
- Plataforma roda em Cloudflare Workers, que **não executa ffmpeg nativo**
- Subir 2.000 fotos × 800KB = ~1,6GB para servidor é inviável sem infra externa
- Client-side é mais privado (fotos de obra nunca saem da máquina) e escala com o hardware do usuário

**Stack:**
- TanStack Start (já configurado)
- `@ffmpeg/ffmpeg` + `@ffmpeg/util` para encode
- `react-dropzone` para upload
- Web Workers próprios para detecção e encode (UI nunca trava)

**Estrutura de arquivos:**
```
src/
  routes/index.tsx              # rota única com a UI
  components/
    UploadZone.tsx
    ProcessingPanel.tsx
    ResultPanel.tsx
  workers/
    detector.worker.ts          # detecção de frames defeituosos
    encoder.worker.ts           # ffmpeg.wasm
  lib/
    pipeline.ts                 # orquestração: detecção → encode → download
    detector.ts                 # heurística pura (testável)
```

## Performance esperada

- 2.000 fotos em laptop moderno (8 cores): detecção ~3-5 min, encode ~5-10 min
- Barra de progresso em duas fases bem visíveis, contador ao vivo
- Recomendação no onboarding: usar Chrome ou Edge (suporte completo a `OffscreenCanvas` em workers)

## O que entrego

App pronto para você arrastar uma pasta de obra real e receber o MP4 limpo. Sem login, sem backend, sem upload — funciona offline depois do primeiro carregamento.
