# Postgres for the app. Smallest Graviton instance, private subnets, reachable
# only from the cluster's nodes. The password is generated here and handed to
# the cluster as a Secret by infra/eks/deploy.sh.

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_security_group" "db" {
  name        = "${var.project_name}-postgres"
  description = "Postgres from the EKS nodes"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "Postgres from cluster nodes"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }

}

resource "aws_db_instance" "postgres" {
  identifier     = "${var.project_name}-postgres"
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "reelwalk"
  username = "reelwalk"
  password = random_password.db.result

  db_subnet_group_name   = module.vpc.database_subnet_group_name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false

  backup_retention_period = 7
  deletion_protection     = false
  skip_final_snapshot     = true
  apply_immediately       = true
}
