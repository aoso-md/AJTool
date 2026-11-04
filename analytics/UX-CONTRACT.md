# Contrato del dashboard privado local

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Select/Listbox | web/src/primitives.tsx Select | parseFilters | Native, short enums | Browser |
| Date | Input native date | UTC date filters | Browser-owned calendar | Validation tests |
| Form | Field/Input/Button | Query API | Read-only filters | API and browser |
| Scrollbar | orca.css | ORCA tokens | Internal wide tables | Narrow viewport |
| Toast | Inline state components | Query result | Alert/status, no transient toast | Browser |
| CRUD | Read-only API, no mutations | PostgreSQL views | Query/detail only | Auth/SQL tests |

El panel requiere sesión local de lectura; no hereda auth=open. Nunca hay usuarios
administradores simulados. Una capacidad de un solo uso y cinco minutos habilita
una sesión HttpOnly/SameSite Strict de dos horas; cierre explícito la revoca. No es
un mecanismo aprobado para publicación remota. Cambiar origen, caducar sesión o
solicitar otra planta produce denegación. La API sólo acepta el alcance sintético
sin planta documentada; no se inventan organizaciones ni pertenencias.

Filtros de identificadores viajan en cuerpo POST, no se conservan en URL o storage.
Las consultas son lecturas PostgreSQL con parámetros. Cambiar filtros reinicia la
página y selección; una petición nueva cancela la anterior. Carga/error/vacío son
distintos y no se conservan cifras viejas como si fueran actuales. Paginación de
detalle por herramienta, orden estable fecha/id, 1–100 filas por página. Calidad
inspecciona hasta 1,000 recientes por fuente y declara su base. Fiabilidad tiene
otro grano: fechas/planta, sin aplicar búsquedas/estado de estudio a eventos.

No actor, notas, observaciones por operador, raw_input ni sobres de eventos en el
navegador. Sólo cifras agregadas de confiabilidad. No exportación masiva añadida.
Nunca sumar promedios, mezclar Cp con Pp o tratar %GRR como varianza. Sin unidades y
revisión de método verificables, la comparación estadística queda bloqueada.
