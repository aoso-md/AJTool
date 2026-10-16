# Preguntas para el equipo de plataforma

Muchas de las preguntas anteriores ya quedaron resueltas leyendo el repo del
core (están al final). Estas son las que solo plataforma puede contestar.

## Para dejarlas en línea

1. **Dar de alta la API key en el core** (`npm run apikey:create` contra la
   base de producción, tabla `api_keys`). Una compartida basta: el scope es `events:read` / `events:write`, no
   por tool. Hoy el core responde 401 a la llave configurada → no está activa.
   Ver `docs/DESPLIEGUE.md` §1.
1b. **rule-qual-005** (core `communication-rules.json`): cambiar
   `triggerCondition` de `cpk < 1.33 OR status == 'not_capable'` a `always`.
   Todo `CAPABILITY_BELOW_TARGET` ya está bajo el mínimo por construcción; con
   un mínimo configurado mayor (p. ej. 1.67, Cpk = 1.5 → `status: marginal`)
   la regla actual no enruta el evento a `manage_product_specs`.
2. **Tokens de proyecto** de Railway (`RAILWAY_TOKEN_CCP`, `RAILWAY_TOKEN_RMA`)
   y confirmar los **nombres de servicio** dentro de cada proyecto (el workflow
   usa `calculate_cpk_ppk` y `run_msa_analysis`).
3. ¿Quién ata `ccp.orcalabs.mx` y `rma.orcalabs.mx` a los servicios? Hoy
   responden el 404 de Railway (dominio sin servicio).
4. ~~¿Quién aplica `docs/deployments-ajtool.patch`?~~ Resuelto: plataforma
   declaró `ccp` / `rma` en el core (`7d12d3f`).
5. ¿El proyecto hoy despliega por la integración de GitHub de Railway? Si
   pasamos al workflow estándar, hay que desconectarla para no desplegar doble.

## SSO

6. `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, y autorizar los
   callbacks de producción **y** de `localhost` (8108 y 8109).
7. `docs/PLATAFORMA-SSO.md` está referido en las plantillas pero no existe en
   `feature/filter`. ¿Dónde está el contrato de roles?

## Dominio

8. **Especificaciones de Cpk:** `MEASUREMENTS_CAPTURED` no trae USL/LSL; las
   tomamos de `PRODUCT_SPEC_UPDATED`. Si una característica nunca tuvo spec
   publicada, el estudio se omite. ¿Es el comportamiento que quieren, o
   `collect_quality_measurements` va a incluir los límites en la medición?
9. **Lecturas de MSA:** `NEW_DEVICE_REGISTERED` no trae lecturas, así que el
   estudio se captura en la interfaz. ¿Algún sistema va a enviar las lecturas
   (por ejemplo, desde el instrumento)?
10. **Criterio de aceptación de MSA:** el valor por defecto es AIAG (%GRR < 10 y
    ndc ≥ 5) y ahora es editable en la tool. ¿Cuál es el criterio de la planta, y
    quién está autorizado a cambiarlo (hoy: roles de calidad)?
11. **Cpk mínimo:** 1.33 por defecto, editable en la tool, con excepciones por
    característica y sobrescribible por evento con `minimumCpk`. ¿Qué
    características llevan otro mínimo (p. ej. 1.67 en críticas)? Ojo: la regla
    rule-qual-005 del core dispara en cpk < 1.33, así que un mínimo menor aquí
    deja a la cadena sin ver casos que sí vigilaría.
12. ¿Linealidad, sesgo y estabilidad (`studyType` en `tools.json`) entran en el
    alcance del 1 de noviembre? Hoy solo `gage_rr`; los otros se rechazan con un
    mensaje claro.

---

## Ya resueltas leyendo el core

- **Forma del evento:** Industrial Event Standard, `additionalProperties: false`
  (`validationService.js`). → `docs/CONTRATO.md`
- **¿Nos llaman o consultamos?** Consultamos: las tools federadas consumen por
  poll de `/events/subscriptions/:toolId` (`deployments.json`, notas).
- **¿Qué hace la plataforma con nuestra respuesta?** Nada: publicamos nosotros
  con `POST /events`, y el bus enruta según `communication-rules.json`.
- **`MSA_NOT_ACCEPTABLE`:** no existe en la plataforma; el veredicto va dentro
  de `MSA_VALIDATED` y la regla filtra `verdict == 'acceptable'`.
- **¿Por qué salían offline?** Sin `subdomain` en `deployments.json` el
  dashboard ni las sondea. → `docs/DESPLIEGUE.md` §0
- **Arranque del poll:** nunca en `since_seq=0`; en la punta, con cursor
  persistido (README del core §5.3, checklist `pasos/09`).
