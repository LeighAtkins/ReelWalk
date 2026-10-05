{{- define "reelwalk.fullname" -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{- define "reelwalk.labels" -}}
app.kubernetes.io/name: reelwalk
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "reelwalk.selectorLabels" -}}
app.kubernetes.io/name: reelwalk
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "reelwalk.secretName" -}}
{{- if .Values.secret.create -}}
{{ include "reelwalk.fullname" . }}
{{- else -}}
{{ required "secret.existingSecret is required when secret.create is false" .Values.secret.existingSecret }}
{{- end -}}
{{- end -}}

{{/* Env for every container: ConfigMap for settings, Secret for credentials. */}}
{{- define "reelwalk.envFrom" -}}
- configMapRef:
    name: {{ include "reelwalk.fullname" . }}
- secretRef:
    name: {{ include "reelwalk.secretName" . }}
{{- end -}}

{{/* Changes whenever config or secret values change, so pods roll on `helm upgrade`. */}}
{{- define "reelwalk.configChecksum" -}}
{{ printf "%s%s" (toJson .Values.config) (toJson .Values.secret.values) | sha256sum }}
{{- end -}}

{{- define "reelwalk.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* The image is immutable at runtime; /tmp is the only writable path (an emptyDir). */}}
{{- define "reelwalk.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
runAsUser: 1000
capabilities:
  drop: ["ALL"]
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* Tools that write to $HOME (Prisma, Chrome, tsx) are pointed at the writable /tmp. */}}
{{- define "reelwalk.homeEnv" -}}
- name: HOME
  value: /tmp
{{- end -}}
