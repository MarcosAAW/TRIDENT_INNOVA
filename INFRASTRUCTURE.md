# Infraestructura — Trident Innova

Este documento describe la configuración de infraestructura y DNS para el proyecto.

## DNS y Nameservers

El dominio `tridentinnova.com` utiliza **Cloudflare** como proveedor de DNS.

### Nameservers activos

| Nameserver                |
|---------------------------|
| lee.ns.cloudflare.com     |
| galilea.ns.cloudflare.com |

### Registros DNS principales

| Subdominio                | Tipo | Dirección IP                |
|---------------------------|------|-----------------------------|
| panel.tridentinnova.com   | A    | 104.21.31.169               |
| panel.tridentinnova.com   | A    | 172.67.178.175              |
| panel.tridentinnova.com   | AAAA | 2606:4700:3034::6815:1fa9   |
| panel.tridentinnova.com   | AAAA | 2606:4700:3031::ac43:b2af   |

> **Nota**: Las direcciones IP corresponden a la CDN de Cloudflare (proxy habilitado).

## Verificación de DNS

Para verificar la configuración de los nameservers:

```bash
dig NS tridentinnova.com +short
```

Para verificar los registros de un subdominio:

```bash
dig panel.tridentinnova.com +short
```

## Notas adicionales

- La configuración DNS se administra desde el panel de Cloudflare.
- Los cambios en DNS pueden tardar hasta 48 horas en propagarse globalmente, aunque típicamente se reflejan en minutos cuando se usa Cloudflare.
- El proxy de Cloudflare proporciona protección DDoS, SSL/TLS y caché de contenido estático.
