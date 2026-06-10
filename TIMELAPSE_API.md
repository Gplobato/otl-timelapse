# Timelapse API

Backend REST para o painel de edicao criar e acompanhar jobs de timelapse.

## Variaveis de ambiente

- `TIMELAPSE_API_KEY`: chave obrigatoria para chamadas server-to-server.
- `TIMELAPSE_NAS_ROOT`: diretorio raiz permitido para leitura das imagens do NAS.
- `TIMELAPSE_OUTPUT_DIR`: diretorio onde os jobs e videos gerados serao salvos. Se ausente, usa o temporario do sistema.

O servidor precisa ter `ffmpeg` disponivel no `PATH`.

## Autenticacao

Enviar uma das opcoes:

```http
Authorization: Bearer <TIMELAPSE_API_KEY>
```

ou:

```http
x-api-key: <TIMELAPSE_API_KEY>
```

## Endpoints

### Health

```http
GET /api/timelapse/health
```

Nao exige autenticacao.

### Listar frames

```http
GET /api/timelapse/list?camera_id=<camera>&from=<iso>&to=<iso>
```

Tambem aceita `source_path`. O caminho sempre fica limitado dentro de `TIMELAPSE_NAS_ROOT`.

### Criar job

```http
POST /api/timelapse/jobs
```

Payload:

```json
{
  "obra_id": "uuid",
  "camera_id": "camera-folder-or-id",
  "from": "2026-06-01T00:00:00Z",
  "to": "2026-06-10T23:59:59Z",
  "fps": 24,
  "resolution": "1080p",
  "mode": "video",
  "filters": {
    "filterNight": true,
    "nightThreshold": 50,
    "filterHours": true,
    "workStart": 8,
    "workEnd": 17,
    "filterInactive": true,
    "inactiveThreshold": 6
  }
}
```

Resposta:

```json
{
  "job_id": "tl_...",
  "status": "queued"
}
```

Tambem e possivel enviar `source_path` ou `frames[]`:

```json
{
  "camera_id": "cam-01",
  "frames": [
    {
      "path": "cam-01/2026/06/image_20260610100000.jpg",
      "name": "image_20260610100000.jpg",
      "timestamp": "2026-06-10T10:00:00Z"
    }
  ]
}
```

### Consultar job

```http
GET /api/timelapse/jobs/:job_id
```

### Listar jobs

```http
GET /api/timelapse/jobs
```

### Baixar resultado

```http
GET /api/timelapse/jobs/:job_id/download
```

O download tambem exige a chave da API.

## Observacoes

- `filterHours` ja roda no backend usando timestamp do nome do arquivo ou `frames[].timestamp`.
- `filterNight` e `filterInactive` ainda mantem o contrato, mas por enquanto sao ignorados no backend e aparecem em `warnings` do job.
- O timestamp automatico procura uma sequencia de 14 digitos no nome do arquivo: `YYYYMMDDHHmmss`.
