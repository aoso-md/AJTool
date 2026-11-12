# AJTool — inteligencia de calidad

Aplicación de producto privada para revisar evidencia industrial, no una landing.
Se conserva el tema Control Room del DESIGN.md raíz: 12 colores ORCA, IBM Plex con
fallback local, superficies planas, bordes y foco visible. No branding nuevo ni fuentes
remotas. `web/src/orca.css` y `primitives.tsx` son adaptadores inicializados desde los
propietarios de CPK; sus fuentes originales no se modifican. La copia mantiene el
patrón de plantillas independientes existente en las dos tools. La identidad de
datos sintéticos y el alcance privado permanecen visibles.

Jerarquía: alcance → conteos principales → composición y actividad observada →
detalle por herramienta o excepción. Los gráficos representan conteos de estudios,
no desempeño de operadores. Tablas para métricas exactas, SVG con texto accesible
para frecuencias, controles nativos para filtros. Unidades y versiones ausentes
impiden una línea de tendencia de capacidad; nunca se rellena con muestras inventadas.

Owners: primitives (Panel, Field, Button, estados), main.tsx (vistas de negocio),
index.css (layout), orca.css (tokens). Locale es-MX, fechas de consulta/agrupación UTC
explícitas. Select y date nativos deliberados: el popup/calendario pertenece al
navegador. Las tablas anchas desplazan dentro de su panel, no el documento.
