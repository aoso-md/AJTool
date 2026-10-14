# IsoTools Obsidian Adapter

## Purpose

Publish quality-tool outputs into IsoTools/Obsidian notes while keeping this repo independent.

## Proposed Notes

- Capability result note per `measurementSetId`.
- MSA result note per `studyId`.
- Event note per emitted event when audit traceability is needed.

## Boundaries

This repo should generate markdown payloads or adapter instructions only. Writing directly into the IsoTools vault requires [EXTERNAL_ADMIN]' approval and should happen in a separate integration step.

