import duckdb
DATASET_PATH = r'D:\exploratory\duckdb-extension\duckdb-cosmograph-oss\lmsys.parquet'
conn = duckdb.connect()
df = conn.query(f"SELECT MIN(x_umap) as min_x, MAX(x_umap) as max_x, MIN(y_umap) as min_y, MAX(y_umap) as max_y FROM '{DATASET_PATH}'").df()
min_x, max_x = df['min_x'][0], df['max_x'][0]
min_y, max_y = df['min_y'][0], df['max_y'][0]
pad_x = (max_x - min_x) * 0.001
pad_y = (max_y - min_y) * 0.001
print(f"minX: {min_x - pad_x}, maxX: {max_x + pad_x}, minY: {min_y - pad_y}, maxY: {max_y + pad_y}")
