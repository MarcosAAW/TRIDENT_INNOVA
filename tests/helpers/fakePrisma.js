const { randomUUID } = require('crypto');

class FakePrisma {
  constructor() {
    this._initialState();
    this._setupDelegates();
  }

  _initialState() {
    this.state = {
      producto: [],
      productoStock: [],
      usuario: [],
      cliente: [],
      sucursal: [],
      venta: [],
      detalleVenta: [],
      movimientoStock: [],
      recibo: [],
      reciboDetalle: [],
      facturaElectronica: [],
      facturaDigital: [],
      notaCreditoElectronica: [],
      notaCreditoDetalle: [],
      aperturaCaja: [],
      cierreCaja: [],
      salidaCaja: []
    };
  }

  _setupDelegates() {
    this.producto = {
      findUnique: async (args) => this._productoFindUnique(args),
      findMany: async (args = {}) => this._productoFindMany(args),
      create: async ({ data }) => this._productoCreate(data),
      update: async ({ where, data }) => this._productoUpdate(where, data),
      deleteMany: async () => this._productoDeleteMany()
    };

    this.productoStock = {
      findMany: async (args = {}) => this._productoStockFindMany(args),
      create: async ({ data }) => this._productoStockCreate(data),
      update: async ({ where, data }) => this._productoStockUpdate(where, data),
      upsert: async ({ where, update, create }) => this._productoStockUpsert(where, update, create),
      deleteMany: async () => this._productoStockDeleteMany()
    };

    this.usuario = {
      create: async ({ data }) => this._usuarioCreate(data),
      deleteMany: async () => this._usuarioDeleteMany()
    };

    this.cliente = {
      create: async ({ data }) => this._clienteCreate(data),
      findUnique: async ({ where }) => this._clienteFindUnique(where),
      findMany: async () => this._clienteFindMany(),
      deleteMany: async () => this._clienteDeleteMany()
    };

    this.sucursal = {
      create: async ({ data }) => this._sucursalCreate(data),
      findUnique: async ({ where }) => this._sucursalFindUnique(where),
      deleteMany: async () => this._sucursalDeleteMany()
    };

    this.venta = {
      create: async ({ data }) => this._ventaCreate(data),
      findUnique: async (args) => this._ventaFindUnique(args),
      findFirst: async (args) => this._ventaFindFirst(args),
      findMany: async (args = {}) => this._ventaFindMany(args),
      update: async ({ where, data, include }) => this._ventaUpdate(where, data, include),
      deleteMany: async () => this._ventaDeleteMany()
    };

    this.detalleVenta = {
      create: async ({ data }) => this._detalleVentaCreate(data),
      deleteMany: async () => this._detalleVentaDeleteMany()
    };

    this.movimientoStock = {
      create: async ({ data }) => this._movimientoCreate(data),
      findMany: async ({ where = {} } = {}) => this._movimientoFindMany(where),
      deleteMany: async () => this._movimientoDeleteMany()
    };

    this.recibo = {
      create: async ({ data }) => this._reciboCreate(data),
      findFirst: async (args = {}) => this._reciboFindFirst(args),
      findMany: async (args = {}) => this._reciboFindMany(args),
      deleteMany: async () => this._reciboDeleteMany()
    };

    this.reciboDetalle = {
      create: async ({ data }) => this._reciboDetalleCreate(data),
      findMany: async (args = {}) => this._reciboDetalleFindMany(args),
      deleteMany: async () => this._reciboDetalleDeleteMany()
    };

    this.facturaElectronica = {
      create: async ({ data }) => this._facturaCreate(data),
      update: async ({ where, data }) => this._facturaUpdate(where, data),
      findUnique: async ({ where }) => this._facturaFindUnique(where),
      findMany: async ({ where } = {}) => this._facturaFindMany(where),
      deleteMany: async () => this._facturaDeleteMany()
    };

    this.facturaDigital = {
      create: async ({ data }) => this._facturaDigitalCreate(data),
      update: async ({ where, data }) => this._facturaDigitalUpdate(where, data),
      findUnique: async ({ where }) => this._facturaDigitalFindUnique(where),
      findFirst: async (args = {}) => this._facturaDigitalFindFirst(args),
      deleteMany: async () => this._facturaDigitalDeleteMany()
    };

    this.notaCreditoElectronica = {
      create: async ({ data }) => this._notaCreditoCreate(data),
      update: async ({ where, data }) => this._notaCreditoUpdate(where, data),
      findFirst: async (args = {}) => this._notaCreditoFindFirst(args),
      findMany: async (args = {}) => this._notaCreditoFindMany(args),
      deleteMany: async () => this._notaCreditoDeleteMany()
    };

    this.aperturaCaja = {
      create: async ({ data, include }) => this._aperturaCajaCreate(data, include),
      upsert: async ({ where, update, create, include }) => this._aperturaCajaUpsert(where, update, create, include),
      findFirst: async (args = {}) => this._aperturaCajaFindFirst(args),
      findUnique: async (args = {}) => this._aperturaCajaFindUnique(args),
      update: async ({ where, data, include }) => this._aperturaCajaUpdate(where, data, include),
      deleteMany: async () => this._aperturaCajaDeleteMany()
    };

    this.cierreCaja = {
      create: async ({ data, include }) => this._cierreCajaCreate(data, include),
      findMany: async (args = {}) => this._cierreCajaFindMany(args),
      findUnique: async (args = {}) => this._cierreCajaFindUnique(args),
      update: async ({ where, data, include }) => this._cierreCajaUpdate(where, data, include),
      deleteMany: async () => this._cierreCajaDeleteMany()
    };

    this.salidaCaja = {
      create: async ({ data, include }) => this._salidaCajaCreate(data, include),
      findMany: async (args = {}) => this._salidaCajaFindMany(args),
      updateMany: async ({ where, data }) => this._salidaCajaUpdateMany(where, data),
      deleteMany: async () => this._salidaCajaDeleteMany(),
      aggregate: async ({ where = {}, _sum = {} } = {}) => this._salidaCajaAggregate(where, _sum)
    };
  }

  async $connect() {
    // no-op
  }

  async $disconnect() {
    // no-op
  }

  async $transaction(callback) {
    const snapshot = this._clone(this.state);
    try {
      const result = await callback(this);
      return this._clone(result);
    } catch (err) {
      this.state = snapshot;
      throw err;
    }
  }

  // Helpers -----------------------------------------------------------------

  _clone(payload) {
    if (payload === undefined || payload === null) {
      return payload;
    }
    return JSON.parse(JSON.stringify(payload));
  }

  _nowISO() {
    return new Date().toISOString();
  }

  _toNumber(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'number') return value;
    const num = Number(value);
    return Number.isNaN(num) ? value : num;
  }

  _matchesContains(value, condition = {}) {
    if (!condition || typeof condition.contains !== 'string') {
      return false;
    }
    const haystack = (value ?? '').toString();
    if (!haystack) return false;
    const needle = condition.contains;
    if (condition.mode && condition.mode.toLowerCase() === 'insensitive') {
      return haystack.toLowerCase().includes(needle.toLowerCase());
    }
    return haystack.includes(needle);
  }

  _ventaMatchesSearchClause(venta, clause = {}) {
    if (!clause || typeof clause !== 'object') return false;

    if (clause.id && this._matchesContains(venta.id, clause.id)) {
      return true;
    }
    if (clause.estado && this._matchesContains(venta.estado, clause.estado)) {
      return true;
    }

    if (clause.cliente) {
      const cliente = this.state.cliente.find((item) => item.id === venta.clienteId);
      if (cliente) {
        return Object.entries(clause.cliente).some(([field, condition]) =>
          this._matchesContains(cliente[field], condition)
        );
      }
    }

    if (clause.usuario) {
      const usuario = this.state.usuario.find((item) => item.id === venta.usuarioId);
      if (usuario) {
        return Object.entries(clause.usuario).some(([field, condition]) =>
          this._matchesContains(usuario[field], condition)
        );
      }
    }

    if (clause.factura_electronica) {
      const factura = this.state.facturaElectronica.find(
        (item) => item.ventaId === venta.id || item.id === venta.factura_electronicaId
      );
      if (factura) {
        return Object.entries(clause.factura_electronica).some(([field, condition]) =>
          this._matchesContains(factura[field], condition)
        );
      }
    }

    return false;
  }

  // Producto ----------------------------------------------------------------

  _productoFindUnique({ where = {} }) {
    const keys = Object.keys(where);
    const record = this.state.producto.find((item) => keys.some((key) => item[key] === where[key]));
    return record ? this._clone(record) : null;
  }

  _productoFindMany(_args) {
    const { where = {} } = _args || {};
    let results = this.state.producto;
    if (where.id && Array.isArray(where.id.in)) {
      results = results.filter((item) => where.id.in.includes(item.id));
    }
    if (where.sucursalId) {
      results = results.filter((item) => item.sucursalId === where.sucursalId);
    }
    if (where.deleted_at === null) {
      results = results.filter((item) => item.deleted_at === null);
    }
    return this._clone(results);
  }

  _productoCreate(data) {
    const now = this._nowISO();
    const record = {
      id: data.id || randomUUID(),
      sku: data.sku,
      nombre: data.nombre,
      descripcion: data.descripcion ?? null,
      tipo: data.tipo,
      precio_venta: this._toNumber(data.precio_venta),
      precio_venta_original: data.precio_venta_original != null ? this._toNumber(data.precio_venta_original) : null,
      moneda_precio_venta: data.moneda_precio_venta ?? 'PYG',
      tipo_cambio_precio_venta: data.tipo_cambio_precio_venta != null ? this._toNumber(data.tipo_cambio_precio_venta) : null,
      precio_compra: data.precio_compra != null ? this._toNumber(data.precio_compra) : null,
      precio_compra_original: data.precio_compra_original != null ? this._toNumber(data.precio_compra_original) : null,
      moneda_precio_compra: data.moneda_precio_compra ?? null,
      tipo_cambio_precio_compra: data.tipo_cambio_precio_compra != null ? this._toNumber(data.tipo_cambio_precio_compra) : null,
      stock_actual: data.stock_actual ?? 0,
      sucursalId: data.sucursalId ?? null,
      codigo_barra: data.codigo_barra ?? null,
      categoriaId: data.categoriaId ?? null,
      minimo_stock: data.minimo_stock ?? null,
      unidad: data.unidad ?? null,
      imagen_url: data.imagen_url ?? null,
      activo: data.activo ?? true,
      created_at: data.created_at ?? now,
      updated_at: data.updated_at ?? now,
      deleted_at: data.deleted_at ?? null
    };

    this.state.producto.push(record);
    return this._clone(record);
  }

  _productoUpdate(where, data) {
    const record = this.state.producto.find((item) => item.id === where.id);
    if (!record) throw new Error('PRODUCTO_NO_ENCONTRADO');

    Object.entries(data).forEach(([key, value]) => {
      if (value && typeof value === 'object' && 'decrement' in value) {
        record[key] = (record[key] ?? 0) - this._toNumber(value.decrement);
      } else if (value && typeof value === 'object' && 'increment' in value) {
        record[key] = (record[key] ?? 0) + this._toNumber(value.increment);
      } else {
        record[key] = value;
      }
    });

    record.updated_at = this._nowISO();
    return this._clone(record);
  }

  _productoDeleteMany() {
    const count = this.state.producto.length;
    this.state.producto = [];
    return { count };
  }

  _productoStockFindMany({ where = {}, select } = {}) {
    let results = this.state.productoStock;
    if (where.sucursalId) {
      results = results.filter((item) => item.sucursalId === where.sucursalId);
    }
    if (where.productoId && Array.isArray(where.productoId.in)) {
      results = results.filter((item) => where.productoId.in.includes(item.productoId));
    }

    return this._clone(
      results.map((item) => {
        if (!select) {
          return item;
        }

        return Object.keys(select).reduce((acc, key) => {
          if (select[key]) {
            acc[key] = item[key];
          }
          return acc;
        }, {});
      })
    );
  }

  _productoStockCreate(data) {
    const now = this._nowISO();
    const record = {
      id: data.id || randomUUID(),
      productoId: data.productoId,
      sucursalId: data.sucursalId,
      stock_actual: this._toNumber(data.stock_actual ?? 0),
      created_at: data.created_at ?? now,
      updated_at: data.updated_at ?? now
    };
    this.state.productoStock.push(record);
    return this._clone(record);
  }

  _productoStockUpdate(where, data) {
    const record = this.state.productoStock.find((item) => item.id === where.id);
    if (!record) throw new Error('PRODUCTO_STOCK_NO_ENCONTRADO');

    Object.entries(data).forEach(([key, value]) => {
      if (value && typeof value === 'object' && 'decrement' in value) {
        record[key] = (record[key] ?? 0) - this._toNumber(value.decrement);
      } else if (value && typeof value === 'object' && 'increment' in value) {
        record[key] = (record[key] ?? 0) + this._toNumber(value.increment);
      } else {
        record[key] = value;
      }
    });

    record.updated_at = this._nowISO();
    return this._clone(record);
  }

  _productoStockUpsert(where, update, create) {
    const composite = where.productoId_sucursalId || {};
    const record = this.state.productoStock.find(
      (item) => item.productoId === composite.productoId && item.sucursalId === composite.sucursalId
    );

    if (record) {
      return this._productoStockUpdate({ id: record.id }, update);
    }

    return this._productoStockCreate(create);
  }

  _productoStockDeleteMany() {
    const count = this.state.productoStock.length;
    this.state.productoStock = [];
    return { count };
  }

  // Usuario -----------------------------------------------------------------

  _usuarioCreate(data) {
    const now = this._nowISO();
    const record = {
      id: data.id || randomUUID(),
      nombre: data.nombre,
      usuario: data.usuario,
      password_hash: data.password_hash,
      rol: data.rol ?? 'ADMIN',
      activo: data.activo ?? true,
      last_login: data.last_login ?? null,
      created_at: data.created_at ?? now,
      updated_at: data.updated_at ?? now,
      deleted_at: data.deleted_at ?? null
    };
    this.state.usuario.push(record);
    return this._clone(record);
  }

  _usuarioDeleteMany() {
    const count = this.state.usuario.length;
    this.state.usuario = [];
    return { count };
  }

  // Cliente -----------------------------------------------------------------

  _clienteCreate(data) {
    const now = this._nowISO();
    const record = {
      id: data.id || randomUUID(),
      nombre_razon_social: data.nombre_razon_social,
      ruc: data.ruc ?? null,
      created_at: data.created_at ?? now,
      updated_at: data.updated_at ?? now,
      deleted_at: data.deleted_at ?? null
    };
    this.state.cliente.push(record);
    return this._clone(record);
  }

  _clienteFindUnique(where = {}) {
    const keys = Object.keys(where);
    const record = this.state.cliente.find((item) => keys.some((key) => item[key] === where[key]));
    return record ? this._clone(record) : null;
  }

  _clienteFindMany() {
    return this._clone(this.state.cliente);
  }

  _clienteDeleteMany() {
    const count = this.state.cliente.length;
    this.state.cliente = [];
    return { count };
  }

  _sucursalCreate(data) {
    const now = this._nowISO();
    const record = {
      id: data.id || randomUUID(),
      nombre: data.nombre,
      ciudad: data.ciudad ?? null,
      direccion: data.direccion ?? null,
      telefono: data.telefono ?? null,
      establecimiento: data.establecimiento ?? null,
      punto_expedicion: data.punto_expedicion ?? null,
      created_at: data.created_at ?? now,
      updated_at: data.updated_at ?? now,
      deleted_at: data.deleted_at ?? null
    };
    this.state.sucursal.push(record);
    return this._clone(record);
  }

  _sucursalFindUnique(where = {}) {
    const keys = Object.keys(where);
    const record = this.state.sucursal.find((item) => keys.some((key) => item[key] === where[key]));
    return record ? this._clone(record) : null;
  }

  _sucursalDeleteMany() {
    const count = this.state.sucursal.length;
    this.state.sucursal = [];
    return { count };
  }

  // Venta -------------------------------------------------------------------

  _ventaCreate(data) {
    const now = this._nowISO();
    const record = {
      id: data.id || randomUUID(),
      usuarioId: data.usuarioId,
      clienteId: data.clienteId ?? null,
      sucursalId: data.sucursalId ?? null,
      fecha: data.fecha ? new Date(data.fecha).toISOString() : now,
      subtotal: this._toNumber(data.subtotal),
      descuento_total: data.descuento_total != null ? this._toNumber(data.descuento_total) : null,
      impuesto_total: data.impuesto_total != null ? this._toNumber(data.impuesto_total) : null,
      total: this._toNumber(data.total),
      total_moneda: data.total_moneda != null ? this._toNumber(data.total_moneda) : null,
      estado: data.estado ?? 'PENDIENTE',
      moneda: data.moneda ?? 'PYG',
      tipo_cambio: data.tipo_cambio != null ? this._toNumber(data.tipo_cambio) : null,
      iva_porcentaje: data.iva_porcentaje != null ? Number(data.iva_porcentaje) : 10,
      condicion_venta: data.condicion_venta ?? 'CONTADO',
      es_credito: data.es_credito ?? false,
      saldo_pendiente: data.saldo_pendiente != null ? this._toNumber(data.saldo_pendiente) : null,
      fecha_vencimiento: data.fecha_vencimiento ? new Date(data.fecha_vencimiento).toISOString() : null,
      credito_config: data.credito_config ?? null,
      factura_electronicaId: data.factura_electronicaId ?? null,
      created_at: data.created_at ?? now,
      updated_at: data.updated_at ?? now,
      deleted_at: data.deleted_at ?? null
    };
    this.state.venta.push(record);
    return this._clone(record);
  }

  _ventaFindUnique({ where = {}, include = {} }) {
    const record = this.state.venta.find((item) => item.id === where.id);
    if (!record) return null;
    const cloned = this._clone(record);
    if (include.cliente) {
      cloned.cliente = this._clone(this.state.cliente.find((item) => item.id === record.clienteId)) || null;
    }
    if (include.usuario) {
      cloned.usuario = this._clone(this.state.usuario.find((item) => item.id === record.usuarioId)) || null;
    }
    if (include.detalles) {
      const detallesInclude = include.detalles;
      const includeProducto = detallesInclude && typeof detallesInclude === 'object' && detallesInclude.include?.producto;
      cloned.detalles = this.state.detalleVenta
        .filter((item) => item.ventaId === record.id)
        .map((item) => {
          const detail = this._clone(item);
          if (includeProducto) {
            detail.producto = this._clone(this.state.producto.find((prod) => prod.id === item.productoId)) || null;
          }
          return detail;
        });
    }
    if (include.sucursal) {
      cloned.sucursal = this._clone(this.state.sucursal.find((item) => item.id === record.sucursalId)) || null;
    }
    if (include.factura_electronica) {
      cloned.factura_electronica =
        this._clone(
          this.state.facturaElectronica.find(
            (factura) => factura.id === record.factura_electronicaId || factura.ventaId === record.id
          )
        ) || null;
    }
    if (include.factura_digital) {
      cloned.factura_digital =
        this._clone(this.state.facturaDigital.find((factura) => factura.ventaId === record.id)) || null;
    }
    if (include.notas_credito) {
      cloned.notas_credito = this.state.notaCreditoElectronica
        .filter((nota) => nota.ventaId === record.id && !nota.deleted_at)
        .map((nota) => this._clone(nota));
    }
    return cloned;
  }

  _ventaFindMany({ where = {}, include = {} } = {}) {
    let results = this.state.venta;

    if (where.usuarioId) {
      results = results.filter((item) => item.usuarioId === where.usuarioId);
    }
    if (where.id) {
      results = results.filter((item) => item.id === where.id);
    }
    if (where.sucursalId) {
      results = results.filter((item) => item.sucursalId === where.sucursalId);
    }
    if (where.deleted_at === null) {
      results = results.filter((item) => !item.deleted_at);
    }
    if (where.fecha) {
      const { gte, lte } = where.fecha;
      results = results.filter((item) => {
        const fecha = new Date(item.fecha);
        if (gte && fecha < new Date(gte)) return false;
        if (lte && fecha > new Date(lte)) return false;
        return true;
      });
    }

    if (Array.isArray(where.OR) && where.OR.length) {
      results = results.filter((item) => where.OR.some((clause) => this._ventaMatchesSearchClause(item, clause)));
    }

    return results.map((record) => {
      const cloned = this._clone(record);
      if (include.cliente) {
        cloned.cliente = this._clone(this.state.cliente.find((item) => item.id === record.clienteId)) || null;
      }
      if (include.usuario) {
        cloned.usuario = this._clone(this.state.usuario.find((item) => item.id === record.usuarioId)) || null;
      }
      if (include.detalles) {
        const detallesInclude = include.detalles;
        const includeProducto = detallesInclude && typeof detallesInclude === 'object' && detallesInclude.include?.producto;
        cloned.detalles = this.state.detalleVenta
          .filter((item) => item.ventaId === record.id)
          .map((item) => {
            const detail = this._clone(item);
            if (includeProducto) {
              detail.producto = this._clone(this.state.producto.find((prod) => prod.id === item.productoId)) || null;
            }
            return detail;
          });
      }
      if (include.sucursal) {
        cloned.sucursal = this._clone(this.state.sucursal.find((item) => item.id === record.sucursalId)) || null;
      }
      if (include.factura_electronica) {
        cloned.factura_electronica =
          this._clone(
            this.state.facturaElectronica.find(
              (factura) => factura.id === record.factura_electronicaId || factura.ventaId === record.id
            )
          ) || null;
      }
      if (include.factura_digital) {
        cloned.factura_digital =
          this._clone(this.state.facturaDigital.find((factura) => factura.ventaId === record.id)) || null;
      }
      if (include.notas_credito) {
        cloned.notas_credito = this.state.notaCreditoElectronica
          .filter((nota) => nota.ventaId === record.id && !nota.deleted_at)
          .map((nota) => this._clone(nota));
      }
      return cloned;
    });
  }

  _ventaFindFirst(args = {}) {
    const results = this._ventaFindMany(args);
    return results && results.length ? results[0] : null;
  }

  _ventaUpdate(where = {}, data = {}, include = {}) {
    const record = this.state.venta.find((item) => item.id === where.id);
    if (!record) {
      throw new Error('VENTA_NO_ENCONTRADA');
    }

    Object.entries(data).forEach(([key, value]) => {
      if (value && typeof value === 'object' && 'set' in value) {
        record[key] = value.set;
      } else if (value instanceof Date) {
        record[key] = value.toISOString();
      } else {
        record[key] = value;
      }
    });

    record.updated_at = this._nowISO();
    return this._ventaFindUnique({ where: { id: record.id }, include });
  }

  _ventaDeleteMany() {
    const count = this.state.venta.length;
    this.state.venta = [];
    return { count };
  }

  // DetalleVenta ------------------------------------------------------------

  _detalleVentaCreate(data) {
    const record = {
      id: data.id || randomUUID(),
      ventaId: data.ventaId,
      productoId: data.productoId,
      cantidad: this._toNumber(data.cantidad),
      precio_unitario: this._toNumber(data.precio_unitario),
      subtotal: data.subtotal != null ? this._toNumber(data.subtotal) : this._toNumber(data.cantidad) * this._toNumber(data.precio_unitario),
      moneda_precio_unitario: data.moneda_precio_unitario ?? 'PYG',
      precio_unitario_moneda: data.precio_unitario_moneda != null ? this._toNumber(data.precio_unitario_moneda) : this._toNumber(data.precio_unitario),
      subtotal_moneda: data.subtotal_moneda != null
        ? this._toNumber(data.subtotal_moneda)
        : (data.subtotal != null ? this._toNumber(data.subtotal) : this._toNumber(data.cantidad) * this._toNumber(data.precio_unitario)),
      tipo_cambio_aplicado: data.tipo_cambio_aplicado != null ? this._toNumber(data.tipo_cambio_aplicado) : null
    };
    this.state.detalleVenta.push(record);
    return this._clone(record);
  }

  _detalleVentaDeleteMany() {
    const count = this.state.detalleVenta.length;
    this.state.detalleVenta = [];
    return { count };
  }

  // MovimientoStock ---------------------------------------------------------

  _movimientoCreate(data) {
    const record = {
      id: data.id || randomUUID(),
      productoId: data.productoId,
      tipo: data.tipo,
      cantidad: this._toNumber(data.cantidad),
      motivo: data.motivo ?? null,
      referencia_id: data.referencia_id ?? null,
      referencia_tipo: data.referencia_tipo ?? null,
      almacen_id: data.almacen_id ?? null,
      usuario_id: data.usuario_id ?? null,
      fecha: data.fecha ?? this._nowISO()
    };
    this.state.movimientoStock.push(record);
    return this._clone(record);
  }

  _movimientoFindMany(where) {
    let results = this.state.movimientoStock;
    if (where.productoId) {
      results = results.filter((item) => item.productoId === where.productoId);
    }
    return results.map((item) => this._clone(item));
  }

  _movimientoDeleteMany() {
    const count = this.state.movimientoStock.length;
    this.state.movimientoStock = [];
    return { count };
  }

  // Recibo -----------------------------------------------------------------

  _reciboCreate(data) {
    const now = this._nowISO();
    const record = {
      id: data.id || randomUUID(),
      numero: data.numero ?? null,
      clienteId: data.clienteId ?? null,
      usuarioId: data.usuarioId,
      sucursalId: data.sucursalId ?? null,
      fecha: data.fecha ? new Date(data.fecha).toISOString() : now,
      total: this._toNumber(data.total),
      total_moneda: data.total_moneda != null ? this._toNumber(data.total_moneda) : null,
      moneda: data.moneda ?? 'PYG',
      tipo_cambio: data.tipo_cambio != null ? this._toNumber(data.tipo_cambio) : null,
      metodo: data.metodo,
      referencia: data.referencia ?? null,
      observacion: data.observacion ?? null,
      estado: data.estado ?? 'PENDIENTE',
      created_at: data.created_at ?? now,
      updated_at: data.updated_at ?? now
    };
    this.state.recibo.push(record);
    return this._clone(record);
  }

  _reciboFindFirst({ where = {}, orderBy, select } = {}) {
    let results = this.state.recibo;
    if (where.sucursalId) {
      results = results.filter((item) => item.sucursalId === where.sucursalId);
    }
    if (where.numero && Object.prototype.hasOwnProperty.call(where.numero, 'not')) {
      results = results.filter((item) => item.numero !== where.numero.not);
    }
    if (orderBy?.numero === 'desc') {
      results = [...results].sort((a, b) => String(b.numero || '').localeCompare(String(a.numero || '')));
    }
    const record = results[0];
    if (!record) return null;
    if (!select) return this._clone(record);
    return Object.keys(select).reduce((acc, key) => {
      if (select[key]) acc[key] = this._clone(record[key]);
      return acc;
    }, {});
  }

  _reciboFindMany({ where = {}, select } = {}) {
    let results = this.state.recibo;
    if (where.sucursalId) {
      results = results.filter((item) => item.sucursalId === where.sucursalId);
    }
    if (where.clienteId) {
      results = results.filter((item) => item.clienteId === where.clienteId);
    }
    if (where.usuarioId) {
      results = results.filter((item) => item.usuarioId === where.usuarioId);
    }
    if (where.fecha) {
      const { gte, lte } = where.fecha;
      results = results.filter((item) => {
        const fecha = new Date(item.fecha);
        if (gte && fecha < new Date(gte)) return false;
        if (lte && fecha > new Date(lte)) return false;
        return true;
      });
    }
    if (!select) {
      return results.map((item) => this._clone(item));
    }
    return results.map((record) =>
      Object.keys(select).reduce((acc, key) => {
        if (select[key]) acc[key] = this._clone(record[key]);
        return acc;
      }, {})
    );
  }

  _reciboDeleteMany() {
    const count = this.state.recibo.length;
    this.state.recibo = [];
    return { count };
  }

  _reciboDetalleCreate(data) {
    const record = {
      id: data.id || randomUUID(),
      reciboId: data.reciboId,
      ventaId: data.ventaId,
      monto: this._toNumber(data.monto),
      monto_moneda: data.monto_moneda != null ? this._toNumber(data.monto_moneda) : null,
      saldo_previo: data.saldo_previo != null ? this._toNumber(data.saldo_previo) : null,
      saldo_posterior: data.saldo_posterior != null ? this._toNumber(data.saldo_posterior) : null
    };
    this.state.reciboDetalle.push(record);
    return this._clone(record);
  }

  _reciboDetalleFindMany({ where = {} } = {}) {
    let results = this.state.reciboDetalle;
    if (where.ventaId) {
      results = results.filter((item) => item.ventaId === where.ventaId);
    }
    if (where.reciboId) {
      results = results.filter((item) => item.reciboId === where.reciboId);
    }
    return results.map((item) => this._clone(item));
  }

  _reciboDetalleDeleteMany() {
    const count = this.state.reciboDetalle.length;
    this.state.reciboDetalle = [];
    return { count };
  }

  // AperturaCaja -----------------------------------------------------------

  _aperturaCajaCreate(data, include = {}) {
    const now = this._nowISO();
    const record = {
      id: data.id || randomUUID(),
      usuarioId: data.usuarioId || data.usuario?.connect?.id || null,
      fecha_apertura: data.fecha_apertura ? new Date(data.fecha_apertura).toISOString() : now,
      fecha_cierre: data.fecha_cierre ? new Date(data.fecha_cierre).toISOString() : null,
      saldo_inicial: this._toNumber(data.saldo_inicial ?? 0),
      observaciones: data.observaciones ?? null,
      created_at: data.created_at ?? now,
      updated_at: data.updated_at ?? now,
      deleted_at: data.deleted_at ?? null
    };

    this.state.aperturaCaja.push(record);
    return this._aperturaCajaInclude(record, include);
  }

  _aperturaCajaUpsert(where = {}, update = {}, create = {}, include = {}) {
    const existing = this.state.aperturaCaja.find((item) => item.id === where.id);
    if (existing) {
      return this._aperturaCajaUpdate(where, update, include);
    }
    const payload = { ...create };
    if (!payload.id && where.id) {
      payload.id = where.id;
    }
    return this._aperturaCajaCreate(payload, include);
  }

  _aperturaCajaFindFirst({ where = {}, orderBy = {}, include = {} } = {}) {
    let results = this.state.aperturaCaja;

    if (where.usuarioId) {
      results = results.filter((item) => item.usuarioId === where.usuarioId);
    }
    if (where.deleted_at === null) {
      results = results.filter((item) => !item.deleted_at);
    }
    if (where.fecha_cierre === null) {
      results = results.filter((item) => !item.fecha_cierre);
    }

    if (orderBy?.fecha_apertura) {
      const direction = orderBy.fecha_apertura.toLowerCase() === 'asc' ? 1 : -1;
      results = [...results].sort(
        (a, b) => (new Date(a.fecha_apertura) - new Date(b.fecha_apertura)) * direction
      );
    }

    const record = results[0];
    return record ? this._aperturaCajaInclude(record, include) : null;
  }

  _aperturaCajaFindUnique({ where = {}, include = {} } = {}) {
    const record = this.state.aperturaCaja.find((item) => item.id === where.id);
    return record ? this._aperturaCajaInclude(record, include) : null;
  }

  _aperturaCajaUpdate(where = {}, data = {}, include = {}) {
    const record = this.state.aperturaCaja.find((item) => item.id === where.id);
    if (!record) {
      throw new Error('APERTURA_CAJA_NO_ENCONTRADA');
    }

    Object.entries(data).forEach(([key, value]) => {
      if (value instanceof Date) {
        record[key] = value.toISOString();
      } else if (key === 'saldo_inicial') {
        record[key] = this._toNumber(value);
      } else {
        record[key] = value;
      }
    });

    record.updated_at = this._nowISO();
    return this._aperturaCajaInclude(record, include);
  }

  _aperturaCajaDeleteMany() {
    const count = this.state.aperturaCaja.length;
    this.state.aperturaCaja = [];
    return { count };
  }

  _aperturaCajaInclude(record, include = {}) {
    const cloned = this._clone(record);
    if (include.usuario) {
      cloned.usuario = this._clone(this.state.usuario.find((item) => item.id === record.usuarioId)) || null;
    }
    return cloned;
  }

  // CierreCaja -------------------------------------------------------------

  _cierreCajaCreate(data, include = {}) {
    const now = this._nowISO();
    const record = {
      id: data.id || randomUUID(),
      usuarioId: data.usuarioId || data.usuario?.connect?.id || null,
      aperturaId: data.aperturaId || data.apertura?.connect?.id || null,
      saldo_inicial: this._toNumber(data.saldo_inicial ?? 0),
      fecha_apertura: data.fecha_apertura ? new Date(data.fecha_apertura).toISOString() : null,
      fecha_cierre: data.fecha_cierre ? new Date(data.fecha_cierre).toISOString() : now,
      total_ventas: this._toNumber(data.total_ventas),
      total_ventas_usd: data.total_ventas_usd != null ? this._toNumber(data.total_ventas_usd) : 0,
      total_efectivo: this._toNumber(data.total_efectivo),
      efectivo_usd: data.efectivo_usd != null ? this._toNumber(data.efectivo_usd) : null,
      total_tarjeta: this._toNumber(data.total_tarjeta ?? 0),
      total_transferencia: this._toNumber(data.total_transferencia ?? 0),
      total_salidas: this._toNumber(data.total_salidas ?? 0),
      efectivo_declarado: data.efectivo_declarado != null ? this._toNumber(data.efectivo_declarado) : null,
      diferencia: data.diferencia != null ? this._toNumber(data.diferencia) : null,
      observaciones: data.observaciones ?? null,
      created_at: data.created_at ?? now,
      updated_at: data.updated_at ?? now,
      deleted_at: data.deleted_at ?? null
    };

    this.state.cierreCaja.push(record);
    return this._cierreCajaInclude(record, include);
  }

  _cierreCajaUpdate(where = {}, data = {}, include = {}) {
    const record = this.state.cierreCaja.find((item) => item.id === where.id);
    if (!record) throw new Error('CIERRE_CAJA_NO_ENCONTRADO');

    Object.entries(data).forEach(([key, value]) => {
      if (value instanceof Date) {
        record[key] = value.toISOString();
      } else if (
        [
          'saldo_inicial',
          'total_ventas',
          'total_ventas_usd',
          'total_efectivo',
          'efectivo_usd',
          'total_tarjeta',
          'total_transferencia',
          'total_salidas',
          'efectivo_declarado',
          'diferencia'
        ].includes(key)
      ) {
        record[key] = this._toNumber(value);
      } else {
        record[key] = value;
      }
    });

    record.updated_at = this._nowISO();
    return this._cierreCajaInclude(record, include);
  }

  _cierreCajaFindUnique({ where = {}, include = {} } = {}) {
    const record = this.state.cierreCaja.find((item) => item.id === where.id);
    if (!record) return null;
    return this._cierreCajaInclude(record, include);
  }

  _cierreCajaFindMany({ where = {}, include = {}, orderBy } = {}) {
    let results = this.state.cierreCaja;

    if (where.usuarioId) {
      results = results.filter((item) => item.usuarioId === where.usuarioId);
    }
    if (where.deleted_at === null) {
      results = results.filter((item) => !item.deleted_at);
    }
    if (where.fecha_cierre) {
      const { gte, lte } = where.fecha_cierre;
      results = results.filter((item) => {
        const fecha = new Date(item.fecha_cierre);
        if (gte && fecha < new Date(gte)) return false;
        if (lte && fecha > new Date(lte)) return false;
        return true;
      });
    }

    if (orderBy?.fecha_cierre === 'desc') {
      results = [...results].sort((a, b) => new Date(b.fecha_cierre) - new Date(a.fecha_cierre));
    }

    return results.map((record) => this._cierreCajaInclude(record, include));
  }

  _cierreCajaDeleteMany() {
    const count = this.state.cierreCaja.length;
    this.state.cierreCaja = [];
    return { count };
  }

  _cierreCajaInclude(record, include = {}) {
    const cloned = this._clone(record);
    if (include.usuario) {
      cloned.usuario = this._clone(this.state.usuario.find((item) => item.id === record.usuarioId)) || null;
    }
    if (include.apertura) {
      cloned.apertura = this._clone(this.state.aperturaCaja.find((item) => item.id === record.aperturaId)) || null;
    }
    if (include.salidas) {
      const salidasInclude = include.salidas;
      const where = salidasInclude.where || {};
      cloned.salidas = this.state.salidaCaja
        .filter((salida) => salida.cierreId === record.id)
        .filter((salida) => {
          if (where.deleted_at === null && salida.deleted_at) return false;
          return true;
        })
        .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
        .map((salida) => this._clone(salida));
    }
    return cloned;
  }

  // SalidaCaja --------------------------------------------------------------

  _salidaCajaCreate(data, include = {}) {
    const now = this._nowISO();
    const record = {
      id: data.id || randomUUID(),
      cierreId: data.cierreId || data.cierre?.connect?.id || null,
      usuarioId: data.usuarioId || data.usuario?.connect?.id || null,
      descripcion: data.descripcion,
      monto: this._toNumber(data.monto),
      fecha: data.fecha ? new Date(data.fecha).toISOString() : now,
      observacion: data.observacion ?? null,
      created_at: data.created_at ?? now,
      updated_at: data.updated_at ?? now,
      deleted_at: data.deleted_at ?? null
    };

    this.state.salidaCaja.push(record);
    return this._salidaCajaInclude(record, include);
  }

  _salidaCajaFindMany({ where = {}, include = {}, orderBy } = {}) {
    let results = this.state.salidaCaja;
    if (where.cierreId !== undefined) {
      results = results.filter((item) => item.cierreId === where.cierreId);
    }
    if (where.cierreId === null) {
      results = results.filter((item) => item.cierreId === null);
    }
    if (where.usuarioId) {
      results = results.filter((item) => item.usuarioId === where.usuarioId);
    }
    if (where.deleted_at === null) {
      results = results.filter((item) => !item.deleted_at);
    }
    if (where.fecha) {
      const { gte, lte } = where.fecha;
      results = results.filter((item) => {
        const fecha = new Date(item.fecha);
        if (gte && fecha < new Date(gte)) return false;
        if (lte && fecha > new Date(lte)) return false;
        return true;
      });
    }

    if (orderBy?.fecha === 'desc') {
      results = [...results].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    }

    return results.map((record) => this._salidaCajaInclude(record, include));
  }

  _salidaCajaUpdateMany(where = {}, data = {}) {
    let count = 0;
    this.state.salidaCaja.forEach((record) => {
      let matches = true;
      if (where.id && Array.isArray(where.id.in) && !where.id.in.includes(record.id)) {
        matches = false;
      }
      if (where.cierreId !== undefined && record.cierreId !== where.cierreId) {
        matches = false;
      }
      if (!matches) return;

      Object.entries(data).forEach(([key, value]) => {
        if (value instanceof Date) {
          record[key] = value.toISOString();
        } else if (key === 'monto') {
          record[key] = this._toNumber(value);
        } else {
          record[key] = value;
        }
      });

      record.updated_at = this._nowISO();
      count += 1;
    });

    return { count };
  }

  _salidaCajaDeleteMany() {
    const count = this.state.salidaCaja.length;
    this.state.salidaCaja = [];
    return { count };
  }

  _salidaCajaAggregate(where = {}, _sum = {}) {
    let results = this.state.salidaCaja;
    if (where.cierreId !== undefined) {
      results = results.filter((item) => item.cierreId === where.cierreId);
    }
    if (where.deleted_at === null) {
      results = results.filter((item) => !item.deleted_at);
    }

    const response = {};
    if (_sum.monto) {
      response._sum = { monto: results.reduce((acc, item) => acc + this._toNumber(item.monto || 0), 0) };
    } else {
      response._sum = {};
    }
    return response;
  }

  _salidaCajaInclude(record, include = {}) {
    const cloned = this._clone(record);
    if (include.usuario) {
      cloned.usuario = this._clone(this.state.usuario.find((item) => item.id === record.usuarioId)) || null;
    }
    if (include.cierre) {
      cloned.cierre = this._clone(this.state.cierreCaja.find((item) => item.id === record.cierreId)) || null;
    }
    return cloned;
  }

  // FacturaElectronica -----------------------------------------------------

  _facturaCreate(data) {
    const now = this._nowISO();
    const record = {
      id: data.id || randomUUID(),
      ventaId: data.ventaId ?? null,
      nro_factura: data.nro_factura ?? null,
      timbrado: data.timbrado ?? null,
      fecha_emision: data.fecha_emision instanceof Date ? data.fecha_emision.toISOString() : data.fecha_emision ?? null,
      xml_path: data.xml_path ?? null,
      pdf_path: data.pdf_path ?? null,
      qr_data: data.qr_data ?? null,
      estado: data.estado ?? 'PENDIENTE',
      respuesta_set: data.respuesta_set ? this._clone(data.respuesta_set) : null,
      intentos: data.intentos != null ? this._toNumber(data.intentos) : 0,
      ambiente: data.ambiente ?? null,
      created_at: data.created_at ?? now,
      updated_at: data.updated_at ?? now
    };
    this.state.facturaElectronica.push(record);
    return this._clone(record);
  }

  _facturaUpdate(where = {}, data = {}) {
    const record = this.state.facturaElectronica.find((item) => item.id === where.id);
    if (!record) {
      throw new Error('FACTURA_NO_ENCONTRADA');
    }

    Object.entries(data).forEach(([key, value]) => {
      if (value && typeof value === 'object' && 'set' in value) {
        record[key] = value.set;
      } else if (value && typeof value === 'object' && 'increment' in value) {
        record[key] = (record[key] ?? 0) + this._toNumber(value.increment);
      } else if (value && typeof value === 'object' && 'decrement' in value) {
        record[key] = (record[key] ?? 0) - this._toNumber(value.decrement);
      } else if (value instanceof Date) {
        record[key] = value.toISOString();
      } else if (value && typeof value === 'object' && !(value instanceof Date)) {
        record[key] = this._clone(value);
      } else {
        record[key] = value;
      }
    });

    record.updated_at = this._nowISO();
    return this._clone(record);
  }

  _facturaFindUnique(where = {}) {
    const keys = Object.keys(where || {});
    const record = this.state.facturaElectronica.find((item) => keys.some((key) => item[key] === where[key]));
    return record ? this._clone(record) : null;
  }

  _facturaFindMany(where = {}) {
    let results = this.state.facturaElectronica;
    if (where && where.ventaId) {
      results = results.filter((item) => item.ventaId === where.ventaId);
    }
    return results.map((item) => this._clone(item));
  }

  _facturaDeleteMany() {
    const count = this.state.facturaElectronica.length;
    this.state.facturaElectronica = [];
    return { count };
  }

  _notaCreditoCreate(data) {
    const now = this._nowISO();
    const detallesCreate = Array.isArray(data?.detalles?.create) ? data.detalles.create : [];
    const record = {
      id: data.id || randomUUID(),
      ventaId: data.ventaId,
      facturaElectronicaId: data.facturaElectronicaId,
      sucursalId: data.sucursalId ?? null,
      nro_nota: data.nro_nota,
      timbrado: data.timbrado,
      establecimiento: data.establecimiento,
      punto_expedicion: data.punto_expedicion,
      secuencia: this._toNumber(data.secuencia),
      motivo: data.motivo,
      tipo_ajuste: data.tipo_ajuste ?? 'TOTAL',
      fecha_emision: data.fecha_emision ? new Date(data.fecha_emision).toISOString() : now,
      moneda: data.moneda ?? 'PYG',
      tipo_cambio: data.tipo_cambio != null ? this._toNumber(data.tipo_cambio) : null,
      total: this._toNumber(data.total),
      total_moneda: data.total_moneda != null ? this._toNumber(data.total_moneda) : null,
      cdc: data.cdc ?? null,
      xml_path: data.xml_path ?? null,
      pdf_path: data.pdf_path ?? null,
      qr_data: data.qr_data ?? null,
      estado: data.estado ?? 'PENDIENTE',
      respuesta_set: data.respuesta_set ?? null,
      intentos: this._toNumber(data.intentos ?? 0),
      ambiente: data.ambiente ?? null,
      created_at: data.created_at ?? now,
      updated_at: data.updated_at ?? now,
      deleted_at: data.deleted_at ?? null
    };
    this.state.notaCreditoElectronica.push(record);

    detallesCreate.forEach((detalle) => {
      this.state.notaCreditoDetalle.push({
        id: detalle.id || randomUUID(),
        notaCreditoId: record.id,
        detalleVentaId: detalle.detalleVentaId ?? null,
        productoId: detalle.productoId ?? null,
        descripcion: detalle.descripcion,
        codigo_producto: detalle.codigo_producto ?? null,
        cantidad: this._toNumber(detalle.cantidad),
        precio_unitario: this._toNumber(detalle.precio_unitario),
        subtotal: this._toNumber(detalle.subtotal),
        iva_porcentaje: this._toNumber(detalle.iva_porcentaje ?? 10),
        created_at: now,
        updated_at: now
      });
    });

    return this._clone(record);
  }

  _notaCreditoUpdate(where = {}, data = {}) {
    const record = this.state.notaCreditoElectronica.find((item) => item.id === where.id);
    if (!record) throw new Error('NOTA_CREDITO_NO_ENCONTRADA');

    Object.entries(data).forEach(([key, value]) => {
      if (value instanceof Date) {
        record[key] = value.toISOString();
      } else {
        record[key] = value;
      }
    });

    record.updated_at = this._nowISO();
    return this._clone(record);
  }

  _notaCreditoFindFirst({ where = {}, orderBy } = {}) {
    let results = this.state.notaCreditoElectronica;

    if (where.timbrado) {
      results = results.filter((item) => item.timbrado === where.timbrado);
    }
    if (where.establecimiento) {
      results = results.filter((item) => item.establecimiento === where.establecimiento);
    }
    if (where.punto_expedicion) {
      results = results.filter((item) => item.punto_expedicion === where.punto_expedicion);
    }
    if (where.deleted_at === null) {
      results = results.filter((item) => !item.deleted_at);
    }

    if (orderBy?.secuencia === 'desc') {
      results = [...results].sort((a, b) => Number(b.secuencia) - Number(a.secuencia));
    }

    return results.length ? this._clone(results[0]) : null;
  }

  _notaCreditoFindMany({ where = {}, orderBy, take, select } = {}) {
    let results = this.state.notaCreditoElectronica;

    if (where.timbrado) {
      results = results.filter((item) => item.timbrado === where.timbrado);
    }
    if (where.establecimiento) {
      results = results.filter((item) => item.establecimiento === where.establecimiento);
    }
    if (where.punto_expedicion) {
      results = results.filter((item) => item.punto_expedicion === where.punto_expedicion);
    }
    if (where.deleted_at === null) {
      results = results.filter((item) => !item.deleted_at);
    }
    if (where.nro_nota?.startsWith) {
      results = results.filter((item) => String(item.nro_nota || '').startsWith(where.nro_nota.startsWith));
    }

    if (orderBy?.secuencia === 'desc') {
      results = [...results].sort((a, b) => Number(b.secuencia) - Number(a.secuencia));
    } else if (orderBy?.created_at === 'desc') {
      results = [...results].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    }

    if (typeof take === 'number') {
      results = results.slice(0, take);
    }

    const mapped = results.map((item) => this._clone(item));
    if (!select) {
      return mapped;
    }

    return mapped.map((item) => {
      const selected = {};
      Object.entries(select).forEach(([key, enabled]) => {
        if (enabled) {
          selected[key] = item[key];
        }
      });
      return selected;
    });
  }

  _notaCreditoDeleteMany() {
    const count = this.state.notaCreditoElectronica.length;
    this.state.notaCreditoElectronica = [];
    this.state.notaCreditoDetalle = [];
    return { count };
  }

  // FacturaDigital --------------------------------------------------------

  _facturaDigitalCreate(data) {
    const now = this._nowISO();
    const record = {
      id: data.id || randomUUID(),
      ventaId: data.ventaId ?? null,
      sucursalId: data.sucursalId ?? null,
      nro_factura: data.nro_factura,
      timbrado: data.timbrado,
      establecimiento: data.establecimiento || '001',
      punto_expedicion: data.punto_expedicion || '001',
      secuencia: data.secuencia != null ? this._toNumber(data.secuencia) : 1,
      condicion_venta: data.condicion_venta || 'CONTADO',
      fecha_emision: data.fecha_emision ? new Date(data.fecha_emision).toISOString() : now,
      moneda: data.moneda || 'PYG',
      total_exentas: this._toNumber(data.total_exentas) || 0,
      total_gravada_5: this._toNumber(data.total_gravada_5) || 0,
      total_gravada_10: this._toNumber(data.total_gravada_10) || 0,
      total_iva_5: this._toNumber(data.total_iva_5) || 0,
      total_iva_10: this._toNumber(data.total_iva_10) || 0,
      total: this._toNumber(data.total) || 0,
      total_iva: this._toNumber(data.total_iva) || 0,
      total_letras: data.total_letras ?? null,
      pdf_path: data.pdf_path ?? null,
      hash_pdf: data.hash_pdf ?? null,
      qr_data: data.qr_data ?? null,
      numero_control: data.numero_control ?? null,
      estado_envio: data.estado_envio || 'PENDIENTE',
      enviado_a: data.enviado_a ?? null,
      enviado_en: data.enviado_en ? new Date(data.enviado_en).toISOString() : null,
      intentos: data.intentos != null ? this._toNumber(data.intentos) : 0,
      created_at: data.created_at ?? now,
      updated_at: data.updated_at ?? now,
      deleted_at: data.deleted_at ?? null
    };
    this.state.facturaDigital.push(record);
    return this._clone(record);
  }

  _facturaDigitalUpdate(where = {}, data = {}) {
    const record = this.state.facturaDigital.find((item) => item.id === where.id);
    if (!record) {
      throw new Error('FACTURA_DIGITAL_NO_ENCONTRADA');
    }

    Object.entries(data).forEach(([key, value]) => {
      if (value && typeof value === 'object' && 'set' in value) {
        record[key] = value.set;
      } else if (value && typeof value === 'object' && 'increment' in value) {
        record[key] = (record[key] ?? 0) + this._toNumber(value.increment);
      } else if (value && typeof value === 'object' && 'decrement' in value) {
        record[key] = (record[key] ?? 0) - this._toNumber(value.decrement);
      } else if (value instanceof Date) {
        record[key] = value.toISOString();
      } else if (value && typeof value === 'object') {
        record[key] = this._clone(value);
      } else {
        record[key] = value;
      }
    });

    record.updated_at = this._nowISO();
    return this._clone(record);
  }

  _facturaDigitalFindUnique(where = {}) {
    const keys = Object.keys(where || {});
    const record = this.state.facturaDigital.find((item) => keys.some((key) => item[key] === where[key]));
    return record ? this._clone(record) : null;
  }

  _facturaDigitalFindFirst({ where = {}, orderBy } = {}) {
    let results = this.state.facturaDigital;
    if (where.id) {
      results = results.filter((item) => item.id === where.id);
    }
    if (where.sucursalId) {
      results = results.filter((item) => item.sucursalId === where.sucursalId);
    }
    if (where.timbrado) {
      results = results.filter((item) => item.timbrado === where.timbrado);
    }
    if (where.establecimiento) {
      results = results.filter((item) => item.establecimiento === where.establecimiento);
    }
    if (where.punto_expedicion) {
      results = results.filter((item) => item.punto_expedicion === where.punto_expedicion);
    }
    if (orderBy && orderBy.secuencia) {
      const direction = orderBy.secuencia.toLowerCase() === 'desc' ? -1 : 1;
      results = [...results].sort((a, b) => (a.secuencia - b.secuencia) * direction);
    }
    return results.length ? this._clone(results[0]) : null;
  }

  _facturaDigitalDeleteMany() {
    const count = this.state.facturaDigital.length;
    this.state.facturaDigital = [];
    return { count };
  }
}

module.exports = { FakePrisma };
